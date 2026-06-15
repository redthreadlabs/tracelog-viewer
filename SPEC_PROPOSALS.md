# tracelog-viewer — SPEC proposals

Design proposals not yet adopted into `SPEC.md`. Each is a *draft* — a direction
we're seriously considering but haven't committed to building. Unresolved
questions are kept inline, on purpose. When a proposal is accepted and built, its
substance graduates into `SPEC.md` and the entry here is marked accepted (or
removed). Nothing in this file is load-bearing yet.

---

## Proposal 1 — User-pluggable indexing

**Status:** draft (2026-06-15). Not building yet.

### Motivation

Today the one aggregate index (the transaction cube) is declared in *code*
(`data/indexes.ts`). But the solver (SPEC §11) already resolves declarative
metric queries against a *registry* of capability descriptors — so the index
*set* is the only thing hard-coded. This proposal turns indexing into a
**user-tunable capability**: the browser stops being just a viewer and becomes a
*tunable query engine* whose indexing strategy each workspace shapes to its own
workload. It lands on the "grows with your service" half of the vision — zero-ops
to start, tunable as you scale.

**Scope:** OLAP-style **aggregate (cube)** indexes only. Inverted indexes
(term → postings, for ad-hoc boolean) are explicitly **out of scope** — a
different structure and query path entirely (see SPEC §11.6).

**Guiding principle — zero-config default + opt-in expert override.** The
built-in transaction cube ships declared and works out of the box; the indexing
page is an advisor-style power surface (under `/internals`) the typical user
never needs to open. This preserves "UX before plumbing" (SPEC §10): the app
still *just handles it* by default. If a good experience ever *required* users to
declare indexes, the feature would have failed that principle.

### Phase 1 — the indexing page (read-only)

A new `/internals/indexing` page, sibling to the store and perf pages. Per
registered index: its declaration (capability), **coverage** (which intervals are
built vs. not), **size on disk** (IndexedDB), and **effectiveness** (queries
served from it vs. scanned, loading avoided) — in the perf page's measurement
spirit. Pure observability; ships regardless of the later phases and validates
the surface the rest grows on.

### Phase 2 — a generic, spec-driven cube engine

Refactor the hand-written `txnIndex` (its `build`/`points` functions) into a
**generic cube** parameterized by a pure-data declaration —
`{ ops, field?, groupBy, granularity }`. One builder + one querier serve any such
declaration; ship the transaction index as the default declared instance. Still
code-declared at this phase — the point is to make the *declaration* data, not
code.

Key property — **declarative-only, never code.** The engine *interprets* a
declaration; it never executes user-supplied functions. This keeps user indexing
inside the CSP/trust guarantee (SPEC §4.1 — `script-src 'self'`, no `eval`). A
custom-*code* index would break that, so we won't allow one. The vocabulary is
the safety boundary.

### Phase 3 — user-declared cubes via config

Let a workspace declare its own cube indexes (additive to the built-in default),
persisted in local config. Two build triggers:

- **Parse-time** — the cheapest moment (records already in hand): any declared
  index builds as its files are parsed, going forward.
- **On-demand backfill** — for files parsed before the declaration existed (or
  since evicted): a query that wants a not-yet-built index materializes it from
  the working set as it resolves, persists it, and warms subsequent queries.
  Honest by construction: an index is an optimization (SPEC §11.5), so backfill
  is lazy/partial and the page shows coverage filling in. The only real cost is
  re-fetching evicted files — which argues for scoping it (see open questions).

The indexing page (Phase 1) gains a **cost advisor**: estimate the distinct-key
cost of a proposed declaration *before* building, show actual size after, and
guard the high-cardinality footguns — grouping by `user`/`trace_id`, or a
multi-dimension cube whose cells grow as the product of cardinalities. This is
exactly where the §11.6 cube-vs-cardinality boundary bites: high-cardinality
grouping is the wrong job for a cube.

### Implication — a richer local config model

This is the part that needs the most design. Today the config is minimal — a
bucket name, a few auth properties, memory/cache limits (SPEC §4). User index
declarations demand a substantially more sophisticated model: a set of
structured, **validated** index declarations per workspace, edited through UI,
**versioned/migratable**, and persisted (localStorage, like the connection). A
malformed or stale declaration must degrade gracefully (ignored, never a crash —
the scan path is always the fallback). This expanded config surface is a
prerequisite for Phase 3 and where most of the risk lives.

### How it builds on what already exists

- The solver's registry + capability descriptor (`matchIndex`,
  `IndexCapability` in `data/indexes.ts`) is already the *shape* of a config
  schema; "config-declared" ≈ populate `INDEXES` from config + the generic cube
  of Phase 2. **The solver itself does not change.**
- File-level projection (`fileGroupBy`, SPEC §11.4) already lets one cube answer
  host/channel groupings for free; the declaration vocabulary would simply
  expose it.

### Open questions

1. **Who declares indexes?** Hosted multi-tenant (per-workspace tuning, no
   redeploy, possibly non-developer users) is where config-declared clearly wins.
   For self-hosters a developer could just edit code, so the payoff is thinner.
   This shapes how much UI to invest.
2. **Where do declarations live — and do they travel?** Per-workspace
   localStorage (like the connection) is the default assumption. But should a
   workspace's index *set* travel in the cross-subdomain directory the way
   workspace *names* do (SPEC §10), or stay strictly local to its origin?
3. **Field discovery.** Suggest indexable fields by sampling the data ("your
   transactions carry a `region` field — index by it?"), or expose a fixed
   vocabulary off the known `Rec` shape? The former is delightful but couples the
   config UI to schema-sniffing.
4. **Backfill scoping.** How aggressive is on-demand backfill — recent-first
   within the operating range, or only user-triggered ("materialize this index
   over this range")? Re-fetching evicted files is the cost to bound.
5. **Cardinality guardrails.** Hard cap on distinct keys, warn-only, or refuse a
   declaration whose estimated cost exceeds a budget? How is it surfaced?
6. **Granularity & dimensionality.** Hourly only (as today), or user-choosable
   granularity? Single `groupBy`, or multi-dimension cubes (with the
   cell-explosion caveat)?

---

## Proposal 2 — A cardinality indexer

**Status:** draft (2026-06-15). Not building yet. Extends Proposal 1.

### Motivation

A per-file index that counts the **distinct values of each field**. Like the
transaction cube it is per-file, built at parse time, immutable (a finalized
file's cardinalities never change), and durable in IndexedDB — the same
lifecycle, zero new machinery. But it is a **different *kind* of index**: it does
not answer a chart's metric, it *describes the data*. "Index" here widens to
"anything derived per-file that informs the engine," and the engine/advisor is
its consumer.

The point: today the cube-vs-don't-cube reasoning rests on *assertions*
("transaction names ~20–30; `user`/`trace_id` are high-cardinality, don't index
them"). A cardinality indexer **measures** that instead of assuming it — turning
the advisor from heuristic guesses into data, in the perf page's "numbers, not
vibes" spirit.

### What it unlocks

- **A real cost model for Proposal 1.** A cube's size ≈ (product of its `groupBy`
  dimensions' cardinalities) × intervals. The cardinality index *is* that input,
  so "this index would cost ~N cells / ~M MB" stops being a guess, and the
  high-cardinality footguns (group by `user`/`trace_id`) are caught before a
  single cell is built.
- **Field discovery (Proposal 1, open question 3) mostly resolves itself.** The
  index already enumerates each field with its distinct count, so the advisor can
  say "`region` (8 distinct) → good cube dimension; `trace_id` (2.1M) → don't" —
  no separate schema-sniffing pass.
- **Possibly the engine's first holistic aggregate** — see the fork below.

### The decision: exact counts vs. mergeable sketches

This choice changes what the index can *do*, not just how it's built:

- **Exact, capped** — a `Set` per field during parse, stopped at a cap (e.g. 10k
  → "high"). Cheap, exact per file, and sufficient for the advisor's only real
  question ("low- or high-cardinality?"). But per-file distinct counts **do not
  merge** — two files' distinct-`user` counts can't be summed without
  double-counting overlaps. Good for advice, useless for range-level distinct.
- **HyperLogLog sketches** — bounded memory (~KB/field regardless of
  cardinality) and **mergeable by union** across files. This is exactly the
  "mergeable sketch" SPEC §11.6 named as the only route to a holistic aggregate.
  With HLL the cardinality indexer does double duty: it feeds the advisor *and*
  becomes the registry's first `merge: 'holistic'` index, answering approximate
  **`COUNT(DISTINCT user)` / unique sessions over an arbitrary range** — a metric
  the cube model fundamentally cannot, and a real observability signal
  (Elasticsearch's cardinality agg is literally HLL). It would graduate
  `holistic` in SPEC §11.2 from "declarable but unmatched" to "served."

Lean: exact-capped is the cheap advisor-only version; HLL is the upgrade that
*also* buys range-level distinct aggregates — likely worth going straight to,
given how little extra it costs and how much it unlocks. Flagged as the open
decision, not settled.

### "All fields" is a deliberate strawman

The original framing — count distinct values for **all** fields — is intentionally
a provocation, not a plan. `meta` carries arbitrary, unbounded keys, so "all
fields" is literally unbounded work and storage. Its purpose is to *beg the real
question*: **which fields?** — the known core schema only, core + top-level `meta`
keys, a capped set, or user-chosen? That is the actual design work. (And note:
*detecting* that a field is accidentally unbounded is itself a useful output —
the indexer can flag "this field looks like runaway cardinality, probably not a
dimension.") We carry "all fields" forward only as the question-shaped
placeholder it is.

### Value lands before any recommender

Worth separating: just *showing* per-field cardinality on the indexing page
(Proposal 1, Phase 1) and feeding it into cube cost estimates is valuable on its
own and cheap. Auto-*recommendations* ("you should build index X") are a later,
higher-effort layer — the indexer's payoff does not depend on building a
recommender.

### Open questions

1. **Which fields?** (the strawman's real question) — core schema, + top-level
   `meta`, capped, or user-selected? How to bound `meta`'s arbitrary keys without
   unbounded work.
2. **Exact-capped vs. HLL**, and if HLL the accuracy/size budget (standard HLL is
   ~1–2% error at a few KB per field).
3. **An `AggregateIndex`, or a separate stats artifact?** With HLL it fits the
   registry as `{ op: 'distinct', merge: 'holistic' }`; exact-only, it's an
   advisor-feeding artifact outside the solver. Depends on the fork above.
4. **Presence vs. distinctness.** Alongside distinct count, is "how often is this
   field populated?" worth storing — sparse-vs-dense informs both advice and
   data-quality?
