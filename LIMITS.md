# LIMITS — how far the browser goes

Tracelog's pitch is "observability essentially for free, until scale makes
it impossible." This file is the *until*, measured. Numbers come from the
viewer's own instrumentation (`#/internals/perf` → copy as JSON) against
the synthetic fleet (`scripts/synth-fleet.mjs`, seed 20260612), so anyone
can reproduce them: generate, sync to a scratch bucket, load a tier, copy
the export.

Measured 2026-06-12 · Apple-silicon MacBook Pro · Chrome 148 · viewer at
commit `e0e07f1`. "Warm" = every file already in the IndexedDB cache;
"cold" = everything over the network.

## The table

| tier | records | gz / raw | cold load | warm load | settled heap | worst stall (warm) | verdict |
|---|---|---|---|---|---|---|---|
| tier-10k | 10,001 | 0.4 / 3.9 MB | sub-second¹ | **27 ms** | 34 MB | none observed | imperceptible |
| tier-100k | 100,004 | 4.2 / 44 MB | **1.03 s** | not yet measured (≪1 s) | not yet measured | — | comfortable |
| tier-1m | 1,000,020 | ~50 / 506 MB | **28.0 s**² | **2.60 s** | **310 MB** | 311 ms | comfortable, loads visibly |

¹ dominated by the S3 LIST round-trip (~100 ms) — at this tier, *planning*
the scan costs more than executing it.
² measured before the streaming-render throttle and raw-shedding landed,
and network-bound regardless (~25 s of wire time for ~50 MB gzipped at
4-way concurrency). The UI-freeze component of a cold load is gone; the
wire time is your connection's problem.

## Unit economics (tier-1m, warm)

- **parse**: ~565k records/s, ~280 MB/s decompressed (1.77 s total,
  worst single file 58 ms)
- **IndexedDB**: ~70 MB/s effective read-back under load
- **heap**: ~310 bytes/record settled, everything included
- **render**: a full-store Overview render at 1M records ≈ 120 ms

Chromium's default per-tab heap limit is ~4 GB; 1M records uses ~8% of it.
The extrapolated *hard* wall is therefore around 10M records in memory, but
the UX wall arrives earlier: full-store renders and the closing sort grow
linearly, so somewhere past ~3–5M records interactions stop feeling
instant. (A `tier-5m` run to pin that number is the remaining M5 task.)

## What the numbers mean for a real service

The synthetic fleet writes ~500 bytes raw per record. At that shape:

- **1M records ≈ a month** of a service doing ~1.4k records/hour around the
  clock — or a week of one doing ~6k/hour. Both load warm in ~2.6 s and fit
  in a third of a GB of tab memory. Comfortable.
- You rarely *want* a million records at once. Hour- and day-scale ranges —
  how the viewer is actually used for debugging — stay in tier-100k
  territory (~1 s cold) for services 10× larger than that.
- The pressure valve is always the same: **narrow the range or the
  channels**, not the tool. Hourly rotation (supported since 1.6.0) makes
  narrow ranges proportionally cheap.

**Recognizing the approach to the limit**: watch the MEM pill and
`#/internals/perf`. Settled heap climbing past ~1 GB, or worst-stall
readings past ~1 s on routine loads, mean your habitual range has outgrown
the browser — graduate that query to a real stack (records are
Elastic-shaped NDJSON; reindexing them is deliberately boring), or narrow
it.

## How the viewer earns these numbers

Each of these was driven by a perf export from this same page — the
methodology is the product:

1. **Per-file intern pools** — V8 internalizes JSON keys, never values;
   high-multiplicity field values are pooled per file so eviction really
   frees them.
2. **Adaptive stream-render throttling** — unthrottled per-file re-renders
   of a growing store are O(n²); a 1M-record cold load spent 26.8 of 28 s
   frozen before this. Data events now wait 5× the previous dispatch's
   cost (1–10 s clamp) while a scan runs.
3. **Raw-line shedding** — retaining each record's NDJSON line (as V8
   SlicedStrings pinning whole decoded files) was ~500 MB of heap at 1M
   records and most of the scan-time GC. Records from cached files now
   drop the line and re-read it on demand (~30 ms, behind a click);
   events/errors keep a flattened copy so deep text search still works.
   This single change: warm load 8.3 s → 2.6 s, heap 760 → 310 MB, worst
   stall 2.1 s → 311 ms.

Remaining rungs if a future tier calls for them: columnar typed arrays per
kind, Worker-side parsing.
