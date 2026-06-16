# Memory management gotchas (parked design notes)

Notes from a design discussion we deliberately **deferred**. The interim decision
is at the bottom; the rest is context for when we revisit accurate memory
accounting. Nothing here is implemented yet beyond the interim.

## The three tiers

A loaded file exists in up to three forms, with very different properties:

| tier | where | size | needed after parse? | restore cost |
|------|-------|------|---------------------|--------------|
| **compressed** | IndexedDB (disk), S3 | smallest (~10×) | the durable backing | re-download |
| **decompressed bytes** (`MemBytes`) | RAM (LRU) | **biggest** (~5 GB) | only on-demand raw-line view | re-inflate (cheap) |
| **parsed records** (`store.records`) | RAM | ~1–3 GB | **every record-view, constantly** | **re-parse (expensive)** |

The durable per-file **indexes** (cube + histogram, IndexedDB) are derived at
parse time and outlive all of this — they need neither bytes nor records once
built.

## The asymmetry (why a single coupled LRU is wrong)

Decompressed bytes are the **biggest** tier and the **least** needed after a file
is parsed-and-indexed (they just wait for a rare raw-line click), and they're
**cheap** to restore (re-inflate from the compressed cache). Parsed records are
smaller, in **constant** demand while in the working set, and **expensive** to
restore (full re-parse).

So eviction eagerness is *opposite* per tier:

- **Bytes: evict first** — big, cheap to bring back, dead weight post-parse.
- **Records: evict last** — only when out of the working set, only under pressure.
- **A bytes eviction must NOT cascade into dropping records** (that's backwards —
  you'd drop the costly-to-restore tier whenever the cheap one ages out).
- **Dropping records orphans that file's bytes** (nothing references them) → they
  become freely droppable / age out.

Conclusion: records should be **their own eviction tier**, a peer to `MemBytes`
keyed by working-set membership + recency — not riding on `MemBytes`.

## The measurement problem (the actual blocker)

We can measure **decompressed byte size exactly** (sidecar `bytes`, per file). We
**cannot** reliably measure parsed-record heap:

- No `performance.memory` in a worker.
- `performance.measureUserAgentSpecificMemory()` *does* run in a worker but needs
  a **cross-origin-isolated** context (COOP+COEP headers — we'd add them to the
  deploy), and is coarse + async. Usable as an occasional **calibration anchor**,
  not a per-decision metric.

So any record budget has to run off a **proxy**:

- **Decompressed size as the proxy** — same currency as `MemBytes`/the clamp,
  exact per file. But it **over-counts** records (they're ~0.4× their source
  text) and conflates verbosity. Conservative → bad for legibility (a 512 MB
  limit would consume ~250 MB).
- **Record count × per-record constant** — record heap scales with the *count*
  of `Rec` objects (each ~constant), not text length. Tracks actual heap far
  better; count is known per file (sidecar `records`). Needs the constant
  calibrated (ideally via `measureUserAgentSpecificMemory`, else a guess ~200 B).

## The legibility requirement (why "centered" matters)

The memory limit is a **user setting** for a technical audience: "this worker may
use 512 MB." The accounting should make 512 MB ≈ 512 MB actual — a **centered**
estimate, not a deliberately conservative (or, as today, optimistic) one. That
implies:

```
estimated heap ≈ Σ(record_count × PER_RECORD_BYTES)   ← dominant, count-driven
              + MemBytes.bytes                          ← real decompressed scratch
              + indexCache + fixed baseline
```

- Charge **records by count**, not decompressed size.
- Calibrate `PER_RECORD_BYTES` against a real `measureUserAgentSpecificMemory`
  reading, occasionally re-anchored.
- **Show the breakdown** on `/internals` (records N × ~B = X MB; scratch Y MB;
  indexes Z MB; total / limit; calibrated ✓/✗) — legibility = showing the math.

Honest ceiling: V8's heap is opaque (hidden classes, GC slack); this is always a
*calibrated estimate*, never exact.

## Today's accounting (the thing to fix later)

`memoryLimitMb` currently bounds **only `MemBytes`** (decompressed bytes). Parsed
records are **uncounted overflow** on top, so the real footprint already exceeds
the nominal limit (~bytes + ~0.4× in records + index cache). "Keep records across
narrows" (the prefetch model) makes that overflow grow.

## Interim decision (what we're building now)

Keep using **`MemBytes` / decompressed-byte size as the memory proxy** — do NOT
build the count-based accounting or the calibration rig yet. Design the LRU
eviction + working-set preload against the decompressed-byte budget we already
have. Revisit this doc when the proxy's inaccuracy actually bites (limit doesn't
map to reality, or records OOM despite being "under budget").

### Strong candidate proxy: compressed size

Once decompressed bytes are no longer held (streaming inflate), a likely-better
proxy than decompressed-size *or* raw count is **compressed (gz) size**. `Rec`
interns low-cardinality string fields (host, channel, name, result, …) into a
string pool, so a file's record heap is dominated by ~unique values + fixed
per-record overhead — which is exactly the low-entropy repetition gzip already
collapses. So compressed size and retained record heap should track each other
well, and compressed size is known per file with zero extra work (it's the byte
we cache). Worth calibrating compressed-size vs. count×const vs. a real
`measureUserAgentSpecificMemory` reading when we do the accounting pass.

### TODO when we revisit
- [ ] Evaluate **compressed size** as the record-heap proxy (string interning
      makes heap track compressed, not decompressed, size).
- [ ] Switch the budget currency to **count-driven estimated heap**.
- [ ] Calibrate `PER_RECORD_BYTES` via `measureUserAgentSpecificMemory` (add
      COOP/COEP to the deploy headers).
- [ ] Make records their own eviction tier; demote `MemBytes` to a small raw-line
      scratch (drop a file's bytes post-parse, re-inflate on demand).
- [ ] Surface the memory breakdown on `/internals` (legible, per-tier, vs limit).
