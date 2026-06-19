# Naming conventions

This is the naming standard for the whole tracelog platform — the agent, the
client SDK, the shared schema, the server's ingest endpoint, and this viewer.
The platform spans many layers (UI strings, URL params, code, S3 keys, the wire
format, the shared library), and the same concept travels through several of
them. Consistent names are what let those layers line up.

## The core rule

**One concept, one word, everywhere.** A concept gets a single name, and that
name is used in every layer it appears in — the UI label, the URL param, the
code identifier, the storage key, the JSON field, and the shared library. Only
the *spelling convention* changes per layer (see [Spelling across
layers](#spelling-across-layers)); the root word does not.

Before introducing a word, check the [vocabulary](#vocabulary) below: if the
obvious word already names a *different* concept, pick a distinct one rather than
overloading it. A few generic words are especially tempting to reuse — they're
[reserved](#reserved-words) for exactly one meaning each.

## Vocabulary

### Storage & the S3 key layout

| Term | Meaning |
|------|---------|
| **bucket** | The Amazon S3 bucket a workspace reads from. Always — and only — the S3 bucket. |
| **channel** | The top-level log namespace in the key layout, e.g. `server`, `client`. |
| **interval** | A storage partition: one log file's date/hour window in the `channel/interval/host` key layout (e.g. `2026-06-15` or `2026-06-15T14`). `hourInterval` is the hourly form used to key indexes and sketches. |
| **host** | The writer — an instance or device — within a channel + interval. |
| **prefix** | An optional key prefix below the bucket root (e.g. `logs/`) that the channels live under. |

The canonical key is `channel/interval/host` (under an optional `prefix`).

### Records

| Term | Meaning |
|------|---------|
| **record** | One parsed log line — the on-disk unit. |
| **kind** | A record's category: `transaction`, `span`, `event`, `error`, `metricset`. |
| **field** | A named value on a record. |

### The `/logs` wire format

What a client SDK sends to the ingest endpoint and the server maps into records.

| Term | Meaning |
|------|---------|
| **event** | A discrete log entry — a log line or behavioral event that happened *at an instant*: level, message, params (`LogEventItem`). Events are **never timed**: there is no duration on an event. A timed operation is a **perf**, not an event. |
| **perf** | A client-side performance measurement — a *timed*, span-shaped operation with trace/parent linkage. The platform-wide word for client timing: `startPerf`/`endPerf`/`recordPerf`, `PerfToken`, `LogPerfItem`, the `perfs` batch field, record type `client-perf`. A parent-less perf maps to a `transaction`, a child to a `span`. |
| **batch** | One envelope of events + perfs plus client info (`LogBatch`). |

### Charts & aggregation (viewer)

| Term | Meaning |
|------|---------|
| **period** | The time width each chart data point aggregates over — the user-selectable granularity. UI label `period`, URL param `period`, code `periodMs` / `periods[]`, the period picker. |
| **bin** | One slot of a distribution histogram (e.g. duration bins): `HistBin`, `bins`. |
| **bar** | The visual rectangle a bar chart draws. A *rendering* term only — the data a bar represents is a **period**. |
| **series** | A named dataset drawn as its own colored band or line (e.g. a transaction name). |
| **step** | A gridline tier on the time axis (minor / medium / major). A grid concept only. |

### Identity & tracing

| Term | Meaning |
|------|---------|
| **trace** (`trace_id`) | The id shared across an entire perf/span tree. |
| **id** / **root_id** / **parent_id** | A node's own id, the tree root, and its parent within a trace. |

### Timing & scheduling (code)

| Term | Meaning |
|------|---------|
| **cadence** | The spacing of a recurring loop, e.g. the flush loop (`flushCadenceMs`). |
| **handle** | A `setInterval` / `setTimeout` id held for later cancellation (`_flushHandle`, `_persistHandle`). |

## Reserved words

These generic words each name exactly one concept. Don't reuse them for another:

- **bucket** → the S3 bucket. An aggregation slot is a **period**; a histogram
  slot is a **bin**.
- **interval** → a storage partition. A chart's aggregation width is a
  **period**; a recurring loop's spacing is a **cadence**.
- **perf** → a client performance measurement. (For a scheduling primitive, use
  **handle**; for a loop's spacing, use **cadence**.)
- **bar** → the drawn rectangle only; its underlying datum is a **period**.
- **event** → a discrete, *instant* log entry. It never carries a duration — if a
  thing is timed, it's a **perf** (→ `transaction`/`span`), not an event.
- **duration** → belongs to a `transaction`/`span`/`perf` only, never an event.

## Spelling across layers

The root word stays the same; each layer applies its own casing:

| Layer | Convention | Example (same concept) |
|-------|-----------|------------------------|
| Code values / functions | `camelCase` | `periodMs`, `startPerf` |
| Code types / classes | `PascalCase` | `LogPerfItem`, `PeriodPicker` |
| Code module constants | `SCREAMING_SNAKE_CASE` | `PERIOD_STEPS_MS` |
| Wire JSON & sidecar fields | `snake_case` | `trace_id`, `tz_offset`, `parent_id` |
| S3 key segments | lowercase path parts | `channel/interval/host` |
| URL / hash params | short lowercase tokens | `ch`, `from`, `to`, `w`, `period` |
| UI labels | lowercase, humane | `period: 1 day` |

So one concept reads, layer to layer, as the same word in different dress —
e.g. perf: `startPerf` (code) → `perfs` (wire field) → `client-perf` (record
type); period: `period` (URL) → `periodMs` (code) → `period: …` (UI label).

## Adding a new term

1. Name the concept **once**. Reuse that word in every layer it touches.
2. Check the [vocabulary](#vocabulary) and [reserved words](#reserved-words)
   first — if the word is taken by a different concept, choose a distinct one.
3. Apply the [layer's casing](#spelling-across-layers). Don't alter the root
   word to fit a layer.
4. When the concept is part of the wire format or the key layout, define it in
   the shared schema so the agent, client, server, and viewer share one source
   of truth.
