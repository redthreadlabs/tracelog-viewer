# tracelog-viewer — SPEC

An entirely in-browser APM and log viewer for tracelog buckets. A static web
page — no server, no backend, no third party — that fetches gzipped JSONL log
files directly from S3 using user-supplied AWS credentials, decompresses them
in the browser, and renders dedicated APM visualizations with D3.

At the scale tracelog targets — a young service writing tens of MB of
compressed logs per month — the entire working set for any reasonable query fits
comfortably in browser memory. This tool leans into that: download, parse,
and visualize locally, with zero infrastructure.

---

## 1. Goals and non-goals

**Goals**

- Browse and visualize everything tracelog writes: transactions, spans,
  errors, events, metricsets — across all channels of one bucket.
- Answer the operational questions an APM UI answers: What's slow? What's
  erroring? What changed since yesterday? What is this user's app doing?
- Work against the live bucket with near-real-time freshness (the `_current`
  snapshots are at most one upload interval — 5 minutes — stale).
- Stay a static page: deployable from a file:// URL, GitHub Pages, or an S3
  static site. Nothing to operate.

**Non-goals**

- No writes of any kind. The viewer holds read-only credentials and issues
  only `ListObjectsV2` and `GetObject`.
- No multi-tenant anything: one bucket, one user, one browser.
- No alerting, retention management, or ingestion — tracelog and S3 lifecycle
  rules own those.
- No support for the pre-1.6.0 flat key layout. The bucket was emptied when
  the new layout shipped; the old archive lives offline.

---

## 2. Prerequisites (bucket-side, one-time)

One-time bucket-side setup; the viewer assumes both are in place:

1. **CORS configuration** on the logs bucket permitting the viewer's origin
   (and `http://localhost:*` for development):

   ```json
   {
     "CORSRules": [{
       "AllowedOrigins": ["https://<viewer-origin>", "http://localhost:5173"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag", "Content-Length", "Last-Modified", "Content-Range", "Accept-Ranges"],
       "MaxAgeSeconds": 3600
     }]
   }
   ```

   Note `ListObjectsV2` is a GET on the bucket URL, so this single rule
   covers listing and fetching. The viewer fetches finalized files with a
   `Range: bytes=0-` GET so S3 returns the object's stored (gzip) bytes
   un-inflated, to cache the compressed form (§8) — the `["*"]`
   `AllowedHeaders` already permits `Range`, so if you narrow that list to
   an explicit allow-list, include `Range`.

2. **A dedicated read-only IAM user** for the viewer, scoped to the logs
   bucket only (`s3:GetObject`, `s3:ListBucket` on
   `arn:aws:s3:::<your-logs-bucket>[/*]`). Never paste an admin key into a
   web page, even your own.

---

## 3. The data contract

This section is normative. It mirrors tracelog 1.6.0's fixed S3 layout —
which exists *because* of this viewer — and the JSONL record schemas. If
tracelog's layout ever changes, this spec and tracelog's CONFIG.md must
change together.

### 3.1 Key layout

```
{channel}/{interval}/{host}[_{seq}][_current].jsonl.gz
```

- **channel** — top-level prefix. A typical deployment's channels: `server`
  (the default channel), `client` (mobile/browser logs relayed via a
  POST /logs endpoint), `unknown-route` (internet-scanner noise diverted by
  transaction routing).
  New channels can appear at any time; the viewer must discover, not assume.
- **interval** — `YYYY-MM-DD` for daily rotation (the most common
  schedule); hourly rotation produces `YYYY-MM-DDTHH`. Lexicographic
  order == chronological order; the viewer's scan planner relies on this.
- **host** — normalized hostname: EC2-internal names are collapsed to the
  dotted IP (`172.31.27.225`); anything else appears verbatim. Hostnames
  cannot contain underscores, so the basename grammar below is unambiguous.
- **basename grammar** — `split('_')` on the basename (after stripping
  `.jsonl`/`.jsonl.gz`):
  - `[host]` — a finalized file
  - `[host, seq]` (numeric) — a finalized size-overflow file (>100 MB day)
  - `[host, 'current']` / `[host, seq, 'current']` — a live snapshot,
    overwritten in place every upload interval. A `_current` file whose
    interval is in the past belongs to a host that died mid-interval and is
    the **only** copy of its final logs — treat it as finalized.

### 3.2 Scan recipes

The viewer composes exactly three S3 access patterns:

| Query | Recipe |
|---|---|
| discover channels | `ListObjectsV2(Delimiter='/')` → `CommonPrefixes` |
| one channel, date range | `ListObjectsV2(Prefix='{channel}/', StartAfter='{channel}/{startDate}')`, read sequentially, stop when keys sort past `{channel}/{endDate}~` |
| live view | within today's interval prefix, basenames ending `_current` |

A date-range scan is **one paginated listing per channel** — never one
request per day. Cross-channel queries fan out over the (few) discovered
channels. Listings are bracketed by UTC *day* labels (correct for daily,
hourly, and even mixed layouts, since hourly keys sort inside their day),
but **fetches are filtered by interval overlap** with the precise
requested range: on an hourly bucket, a "last 15 minutes" range fetches
only the covering hour file(s); on a daily bucket it fetches the covering
day, as before.

### 3.3 File format

Each file is gzipped NDJSON (one JSON object per line).

- Objects are uploaded with `Content-Encoding: gzip`, so a plain `fetch`
  decompresses transparently. Implementation must not double-gunzip: check the
  response, and `DecompressionStream('gzip')` only when the body is still
  compressed. For finalized files we instead issue a `Range: bytes=0-` GET so
  S3 returns `206 Partial Content` — which browsers never auto-inflate — and
  we receive the stored gzip bytes verbatim, to cache the compressed form
  (§8) and inflate locally. A gzip-magic check makes both paths safe, and the
  Range probe self-disables if rejected (e.g. CORS), falling back to the
  plain decompressed GET.
- **Line 1 is a `metadata` record** describing the writing process: service
  name/version/environment, agent version, process, system, cloud (account,
  instance id, AZ, machine type), and `channel`. Every subsequent record
  implicitly belongs to that context. Multi-process days can produce a file
  with metadata appearing again mid-file after a process restart — parse
  positionally, not just on line 1.
- Every other line is a single-key object identifying its kind:
  `{"transaction": {...}}`, `{"span": {...}}`, `{"error": {...}}`,
  `{"event": {...}}`, `{"metricset": {...}}`.

### 3.4 Record kinds and the fields the viewer uses

| Kind | Key fields |
|---|---|
| `transaction` | `name`, `type`, `result` (e.g. `HTTP 2xx`), `outcome`, `id`, `trace_id`, `duration` (ms), `context.request` / `context.response`, `span_count` |
| `span` | `name`, `type`/`subtype` (e.g. `db/mongodb`), `id`, `trace_id`, `transaction_id`, `parent_id`, `duration` (ms) |
| `metricset` | `samples` (name → `{value}`), optional `transaction`/`span` attribution (breakdown metrics), `tags` |
| `event` | `type`, `level` (`debug`/`info`/`warn`/`error`, always present), `message`, optional `duration` (ms), `error` (`{message, type?, code?, stack?}`), `user.id`, `client` (app/os/device/runtime), `params`, and `trace_id`/`transaction_id` when the event was written inside a server transaction |
| `error` | captured exceptions: `exception`/`log`, `trace_id`/`transaction_id` linkage |

As of tracelog 1.7.0, units are uniform: **every `timestamp` is epoch-µs and
every `duration` is ms** — the historical ms-event exception is gone (the
bucket holds only ≥1.7.0 data; see §3.6). Normalize µs→epoch-ms at parse
time, in one place.

**Channel-specific shapes:**

- `server`: transactions + spans + metricsets + events + errors (full APM).
- `client`: events, plus **span-shaped client perf timers** — the server's
  LogsEndpoint converts client timer batches into `transaction` records (root
  timers) and `span` records (child timers) with shared `trace_id`s, so the
  trace waterfall works for client perf too. Client events carry `user.id`,
  device/app info, and `params.ip_address`.
- `unknown-route`: transactions (scanner probes) and their breakdown
  metricsets. Useful for security curiosity, excluded from APM rollups by
  default.

### 3.5 Data quirks the viewer must tolerate

- **Client clock + backlog flushes.** The mobile app persists unsent logs
  (AsyncStorage) and flushes them on next launch; event timestamps are device
  time and can arrive days late. Views bucket by *event* timestamp; a
  freshness indicator should use the file's `Last-Modified` instead.
- **Out-of-order lines.** Within a file, records are roughly but not strictly
  chronological (async encode, span buffering). Sort after parse.
- **Duplicate-ish currents.** During an interval, a `_current` snapshot's
  contents are a prefix of the eventual finalized file. Never load both: if
  the finalized key exists, ignore the (briefly surviving) `_current`.
- **Unknown record kinds / extra fields** must be ignored, not fatal —
  tracelog will grow.

### 3.6 Field-verified notes (bucket inspection 2026-06-11, revised for 1.7.0)

Verified against a live production bucket on day one of the
1.6.0 layout, then revised after the tracelog 1.7.0 schema-smoothing pass
(which several of these findings prompted). The bucket is wiped of
pre-1.7.0 objects once 1.7.0 deploys, so **the viewer targets the 1.7.0
schema only** — no version-conditional parsing.

Still true, build for these:

- **Uploads carry `Content-Encoding: gzip` + `ContentType:
  application/x-ndjson`** (verified via `HeadObject`), so browser `fetch`
  decompresses transparently. `ETag` is present for the cache-immutability
  check.
- **Client perf-timer traces not yet observed in prod.** The first day's
  `client` file was 100% events (2,169 of them) — the timer→transaction/span
  conversion exists in LogsEndpoint but no timers have landed yet. Build the
  client waterfall from the LogsEndpoint contract (`timestamp` ms→µs,
  `transaction_id` = root timer id), and expect the kind mix per channel to
  shift over time.
- **Volume skew is extreme**: `GET /user/:user_id/exists` was ~90% of server
  transactions on day one. Transaction tables need solid sorting and a quick
  exclude-by-name affordance so one chatty route doesn't bury the rest.
- **`unknown-route` transactions carry full request context** (raw URL,
  `x-forwarded-for`, user-agent, response status) — the scanner view can show
  top paths, top source IPs, and top user agents from data already present.
- **`metadata.cloud` may be absent.** 1.7.0 holds the first write (bounded)
  for the async cloud-metadata fetch, which should make it reliably present
  on EC2 — but render cloud fields only when present.

Fixed in tracelog 1.7.0 (the viewer can rely on the fixed behavior, but
defensive parsing never hurts):

- **Empty `{}` context placeholders** are no longer serialized anywhere.
- **Hostnames are normalized everywhere**: `metadata.system.hostname` and
  metricset `tags.hostname` now match the key host (EC2 `ip-A-B-C-D[...]` →
  dotted IP), so host filtering needs exactly one rule.
- **`[object Object]` error messages**: day-one data showed these, and the
  root cause was *not* (only) stale app builds — tracelog's own
  `_buildEvent` stringified error-like plain objects server-side, clobbering
  even client errors fixed by tracelog-client 1.3.1. Fixed at the source;
  real messages/codes flow through now.
- **Outcome/result conventions**: manual transactions ending with an
  explicit `success`/`failure`/`error` result now derive the matching
  outcome (server integrations pass explicit results as of the 1.7.0
  schema pass), so outcome rollups are trustworthy across both conventions.
- **`event.level` is always present** (defaults to `info`); single-write
  server events carry `trace_id`/`transaction_id` when written inside a
  transaction — the events view can offer "events for this trace".
- **`metadata.service.node.configured_name`** carries the configured node
  name (e.g. `ddd-prod-server`).

---

## 4. Credentials and security model

- Config panel collects: access key ID, secret key, optional session token,
  region, bucket name. Multiple named profiles (e.g. prod / dev buckets).
- Credentials live **in memory** by default; an explicit "remember on this
  device" opt-in persists them to `localStorage` with plain wording about
  what that means. No cookies, no transmission anywhere except AWS SigV4.
- All S3 access via `@aws-sdk/client-s3` in the browser (it is fetch-based
  and works client-side). No hand-rolled signing.
- The page must contain zero third-party runtime requests (no CDN scripts,
  no fonts, no analytics) — both as a security property and so it works
  offline against cached data.

### 4.1 Transparency and Content-Security-Policy

Because the viewer asks people to point it at their *private, sensitive* logs,
its trustworthiness must be **verifiable**, not asserted:

- **Readable source.** The build ships source maps (`build.sourcemap: true`),
  so anyone can open DevTools → Sources and read the original TypeScript —
  file by file, with comments — rather than a minified blob. We keep
  minification (it only affects the bytes on the wire; maps are fetched only
  when DevTools is open) because a minified-but-mapped bundle is both smaller
  *and* a better audit artifact than an unminified concatenated one.
- **A Content-Security-Policy as the verifiable half.** Readable source proves
  intent; the CSP proves the browser *can't* do otherwise. It is delivered as a
  **CloudFront response-headers-policy** provisioned by `scripts/deploy-site.mjs`
  (the `headers` step — created/adopted by name, attached to the default cache
  behavior, idempotent like the rest of the script). The policy:

  ```
  default-src 'self'; script-src 'self'; worker-src 'self';
  connect-src 'self' https://*.amazonaws.com; img-src 'self' data:;
  style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none';
  base-uri 'self'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'
  ```

  The anti-exfiltration guarantee lives in `connect-src`/`default-src`/
  `form-action`: the page **and its same-origin worker** (where the S3 SDK runs)
  can reach only this origin and Amazon S3 — the user's own log bucket — and
  nowhere else. The browser physically cannot POST their logs to a third party.
- **The one relaxation is `style-src 'unsafe-inline'`** — the UI sets dynamic
  inline styles (computed kind colors, bar widths) that can't be hashed. This
  does *not* weaken the exfiltration guarantee (that is not a `style-src`
  concern). The directive that could enable exfiltration, `script-src`, stays
  strict `'self'`: the code base has no `eval`/`Function`/wasm and no inline
  scripts (audited), so no `'unsafe-inline'`/`'unsafe-eval'` is needed there.
- **Applied to *every* response, not just `index.html`.** A worker's fetches
  are governed by the CSP on its own script response, so the worker `.js` must
  carry `connect-src` too — otherwise the S3 SDK breaks under enforcement.
- **Rollout: report-only first.** The policy ships as
  `Content-Security-Policy-Report-Only` (`--csp-enforce` flips the header name
  to the enforcing `Content-Security-Policy`). A `<meta>` tag *cannot* express
  report-only — browsers honor it only as a real header — which is the other
  reason the policy lives at CloudFront rather than in the HTML.
- The policy rides alongside `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY` (mirroring `frame-ancestors 'none'`), and
  `Referrer-Policy: same-origin` (no `Referer` leaks cross-origin to S3).
- **Tuning for other deployments:** widen `connect-src` if the logs live behind
  a custom domain or an S3-compatible endpoint (Cloudflare R2, MinIO, …).

---

## 5. Architecture

Vanilla TypeScript, direct DOM manipulation, no UI framework. D3 for all
charts. **Vite** as the build step (its dev server is the `localhost:5173`
already baked into the CORS rule) bundling TS + the AWS SDK into a static
`dist/`.

```
src/
  s3/        client.ts        — SDK wrapper: list, get, head (typed, minimal)
             scanner.ts       — channel discovery + date-range scan planner (§3.2)
  data/      parse.ts         — NDJSON parse, kind dispatch, timestamp normalization
             store.ts         — in-memory record store + file-rooted index
                                bundles (per-kind arrays; transactions by
                                name; records by trace_id) — the logfile is
                                the root unit of memory management, so
                                evicting a file drops its whole bundle and
                                everything GCs together; cross-file queries
                                merge bundles, memoized per generation
             cache.ts         — IndexedDB cache of *finalized* files keyed by
                                bucket + S3 key, ETag-checked (immutable, so
                                cache forever; namespaced because every
                                tracelog bucket repeats the same key paths);
                                stores the gzip-COMPRESSED bytes (§8);
                                _current files are never cached. Survives
                                profile switches; deleting the last profile
                                for a bucket wipes that bucket's entries
             blobs.ts         — two-tier byte cache: in-memory decompressed
                                LRU (MemBytes, bounded by the memory limit) in
                                front of cache.ts; inflate/deflate on the
                                boundary so disk stays compressed, RAM hot
             gzip.ts          — gzip/gunzip over (De)CompressionStream + magic
             ledger.ts        — persistent per-file size record (compressed +
                                decompressed, per-channel ratios) that OUTLIVES
                                the byte cache: drives memory-limit estimates,
                                cache-limit (LRU) eviction, re-fetch reasoning
  ui/        app.ts           — shell, routing (hash-based), layout
             config.ts        — credentials/profiles panel
             scanbar.ts       — channel / date-range / host / live controls
             theme.ts         — light/dark theme switching (§7 tokens)
             views/…          — one module per view (§6)
  viz/       …                — D3 chart components (histogram, timeseries,
                                waterfall, stacked bars, heatmap)
```

Data flow: scanbar state → scanner produces a key list → cache/fetch layer
materializes records → store indexes them → views render from the store and
subscribe to its updates. Live mode re-fetches `_current` keys on a 60s
timer and patches the store incrementally: the per-cycle listing's ETags
decide which files changed at all (an unchanged snapshot costs nothing —
cheaper than conditional GETs), and because files are append-only (§3.5) a
changed snapshot is parsed *incrementally* — the previous byte length and
boundary bytes are remembered, verified against the new content, and only
the tail is decoded, parsed (metadata context carried over), and appended;
any mismatch falls back to a full re-parse. Each cycle also re-lists
today's prefix to catch finalization (finalized key appears → drop the
`_current` copy, §3.5).

---

## 6. Views

### 6.0 Shell

Persistent header: profile picker, scanbar (channels multi-select populated
by discovery; datetime-range picker with quick presets — 15 min through
30 d; LIVE toggle). Setting a range **is the user's intent**: the app
fetches whatever satisfies it, behind the scenes and as needed, with
loading progress ("loading 12 MB of 48 MB…") as the only acknowledgment —
no confirmation step at any size (decided 2026-06-13). Sub-day ranges
scan the covering UTC day(s) and narrow the viewed time window to the
precise range (the same mechanism as the chart brush). The loaded readout
("12,345 records · 48 MB") links to the store inspector. Pages about the
app itself — never the observed service — live under a distinct
`#/internals/…` route family (so "store"/"perf" can't be confused with
log content): the store inspector (`#/internals/store`, the opt-in page
where file-level detail — per-file sizes, counts, eviction — lives) and
viewer performance (`#/internals/perf`, §6.8), cross-linked by a shared
tab strip.

### 6.1 Overview dashboard

The "is everything okay" page.

- Stacked bar: record volume per day per channel (from listing sizes alone —
  this renders before any file is fetched, then refines with record counts).
- Error/warn event count trend; latest deployment markers (derived from
  `metadata.service.version` changes between files).
- Top transactions by p95 duration; top event types by volume — each row
  links into the deeper views.

### 6.2 Transactions (APM)

- Table grouped by `transaction.name`: count, RPM, p50/p95/p99 duration,
  outcome/result breakdown. Sortable; filter by type.
- Selecting a name: duration histogram (D3), duration-over-time scatter,
  status-code mix, slowest-N instances.
- Selecting an instance → trace waterfall.

### 6.3 Trace waterfall

For one `trace_id`: the transaction bar with child spans laid out on a time
axis, colored by `type/subtype` (db/mongodb, db/redis, storage/s3, app, …),
with the span gaps ("self time") visually evident. Works identically for
server traces and client perf-timer traces (§3.4). Side panel shows the raw
record JSON.

### 6.4 Events & errors

- Filterable, virtualized table: time, level, type, message, user, device.
  Free-text search over message + params. Facets for level and type.
- Error inspector: `error.message` (now containing real messages and codes,
  post tracelog-client 1.3.1), stack when present, doc context params
  (`collection`, `doc_id`), and one-click "show this user's surrounding
  events ±5 minutes" — the primary field-debugging move.

### 6.5 Metrics

- Runtime timeseries from `metricset.samples`: event-loop delay, heap/RSS,
  CPU — one small-multiples row per host, deployment markers overlaid.
- Breakdown metrics (span.self_time by transaction name) as a stacked area,
  when present.

### 6.6 Client analytics

Client-originated records cut by `user.id` / device. Selection is
**content-based** — an event/error counts as client-originated when it
carries client identity (`event.client.*` device / OS / app version);
a channel conventionally named `client` is honored as a secondary hint
(channel names are deployment-specific, content is the contract, §3.2).
The cuts: sessions (gaps > 15 min),
app versions in the wild, slow-query perf events (everything ≥ the 100 ms
client threshold), review-session funnels from lifecycle events. This view
is opinionated only in its display defaults and generic in mechanism
(group by `event.type`).

### 6.7 Scanner traffic (unmatched routes)

A deliberately small view: probes per day, top requested paths, top user
agents. Selection is **content-based**: agents name a transaction that
matched no route `<METHOD> unknown route`, so that name is the signal in
any deployment; a channel conventionally named `unknown-route` (write-time
diversion) is honored as a secondary hint. Mostly entertainment; excluded
from all other rollups.

### 6.8 Viewer performance (#/internals/perf)

The viewer watching itself: a capped ring-buffer log (`data/perf.ts`,
1000 entries — bounded per §8) of internal timings, rendered newest-first
in the store-inspector's visual language. Categories: `list` (scan
planning), `fetch` (per object, network vs IndexedDB flagged), `parse`
(per file, with records + bytes), `scan` (whole executeScan summaries),
`render` (route navigations, plus every store-data dispatch ≥1 ms — all
subscribers re-render synchronously inside it, so this is the incremental
UI cost as the store grows; the perf page itself is excluded to avoid a
feedback loop), `live` (non-idle ticks), and
`stall` (longtask observer: main-thread blocks ≥50 ms). Entries stamp
the Chromium tab heap when available. Summary ledger: session counts +
worst stall | network/cache/parse throughput | tab heap. A copy-as-JSON
export is the measurement instrument for §8.1 stress runs — LIMITS.md
numbers come from here, and users can attach exports to bug reports.
Instrumentation cost is two `performance.now()` calls and one object per
operation, so it is always on.

## 7. Design language

The charts are the product. Goal: closer to a beautifully typeset report
than a NOC dashboard — restrained, humane, with color spent only on data.

- **Light and dark themes, both first-class**, switchable via a header
  toggle and defaulting to `prefers-color-scheme`. All colors (UI *and*
  chart) come from CSS custom-property tokens on `:root` /
  `[data-theme=dark]`; D3 code reads tokens via `getComputedStyle`, never
  hard-codes a color. Theme switch re-renders charts.
- **One categorical palette for span/transaction types**, stable across every
  view: `db/mongodb`, `db/redis`, `storage/s3`, `external/http`, `app`,
  `custom`, … get fixed hues, with per-theme lightness variants tuned for
  contrast on each background. A user learns "green = mongo" once.
- **Sequential/diverging scales** for heatmaps and intensity; a fixed
  semantic mapping for event levels (debug → muted, info → neutral, warn →
  amber, error → red) reused in tables, facets, and charts.
- **Typography**: a system font stack (no webfont downloads — §4's
  zero-third-party rule); tabular numerals (`font-variant-numeric:
  tabular-nums`) everywhere numbers align — tables, axes, tooltips.
- **Shared chart chrome**: one axis/grid/tooltip/legend component family so
  every chart agrees on tick formatting (durations as `1.2 s` / `840 ms` /
  `64 µs`, bytes as `3.2 MB`, counts with comma grouping), margins, and
  hover behavior.
  - **Time-axis grid** (`viz/timegrid.ts`): every time-series chart draws
    faint background gridlines at calendar-aligned boundaries, each line's
    opacity scaled to the *significance* of the boundary it lands on
    (second < minute < hour < day < week < month < year), so the time
    structure reads straight from the background. Labels are formatted in the
    unit each tick represents (`2026`, `Jun`, `Jun 9`, `14:00`); calendar
    labels (day and up) anchor the row in semibold ink, sub-day times recede.
  - **Zone-aligned bucketing**: bar grids anchor to the active display
    zone's midnight (`aggregate.ts` `zoneMidnight`), not the raw epoch, so a
    "1 day" bar is a *local* day and calendar gridlines fall between bars
    rather than drifting by the sub-bucket timezone remainder. Uniform-ms
    stepping from the anchor keeps bucket assignment O(1). **Known tradeoff:**
    across a DST transition the uniform-ms grid drifts ≤1h (30 min in
    half-hour zones) from wall clock for the portion of a window *after* the
    transition — invisible at day-zoom (~4% of a bar), up to ~33% of a 3h
    bar at fine zoom. It self-heals (any window starting after the transition
    re-anchors), and UTC mode is immune. **Future enhancement:** an optional
    DST-exact mode using calendar-stepped (non-uniform) bucket boundaries —
    correct through any transition, at the cost of the O(1) `floor((ts −
    start)/bucketMs)` assignment (it would need a boundary array + binary
    search per record). Deferred deliberately: the bounded, self-healing,
    fine-zoom-only drift beats re-introducing per-record search.
  - **Working-set fulfillment (ghost band)** — one overlay primitive meaning
    *the working set is unfulfilled in this span*, drawn as a muted band in the
    chart background. It marks intervals the memory budget **refused** — in the
    selection but clamped out of what the loader will load, so their records
    will never arrive — landing that over-budget signal spatially on the chart,
    not only in the inspector banner. This coexists with the no-partial-intervals
    rule: an interval whose files are still loading is *blanked* (we can't know
    its true height — a misleadingly short bar is worse than none), while a
    budget-refused interval is ghosted (it will never fill, so say so). **Scoping:**
    the band means *intended-but-unfulfilled* — the working set's unmet demand
    (budget-refused), NOT the ordinary absence of records outside the loaded
    window (records load lazily by window, so most of a long chart has none by
    design and must stay un-ghosted).
    - **Drill-down (records-based charts).** The transaction detail carries the
      same primitive for the over-budget (records-refused) case. The
      duration-over-time **scatter** has a time axis, so it draws the band over
      the refused spans and extends its domain to cover them (the loaded points
      compress to a recent sliver, the refused range shows as hatch rather than
      vanishing). The duration **histogram** has no time axis, so when its
      instance set is partial the *whole panel* is washed with the same hatch —
      the honest "this distribution is built on data the budget refused" signal.
      A hover anywhere in a ghosted region appends a "DATA IS PARTIALLY LOADED"
      footnote to the tooltip.
- **Interaction grammar**: brush horizontally to zoom time (double-click to
  reset); hovering any time-axis chart shows a synced crosshair in the
  others; click-through follows the drilldown chain (overview → transaction
  group → instance → waterfall). Transitions are short (~150 ms) and only on
  user action, never ambient animation.
- **SVG-first D3**; switch a specific chart to canvas only if profiling
  shows SVG is the bottleneck (the duration scatter over a month of data is
  the likely candidate).

## 8. Performance budget

- Parse target: 100 MB/s-class NDJSON parsing is achievable with
  `TextDecoderStream` + line splitting; a full month of post-cleanup logs
  (~50 MB uncompressed) should load from warm cache in ~1s and from S3 in a
  few seconds on a normal connection.
- Memory: thrift is a feature — every MB of headroom extends how long a
  growing service stays on tracelog, so memory tricks do not require a
  measured justification first (decided 2026-06-12). Built in: a manual
  string intern pool for high-multiplicity fields (V8 internalizes JSON
  *keys* but never values), and raw shedding (M5 finding, 2026-06-12: raw
  retention was ~500 MB of the 760 MB heap at 1M records and most of the
  scan-time GC) — records from finalized files drop their raw line
  entirely; the drawer re-reads it from the IndexedDB cache by
  sourceKey + line index (rawsource.ts, ~30 ms behind a click).
  Events/errors keep a *flattened copy* of their line so free-text search
  stays deep where it's used (a plain slice would pin the whole decoded
  file text via its SlicedString parent); `_current` records keep slices
  of the small live tail. Next on the ladder if the M5 measurements call
  for it: columnar typed arrays per kind (Worker-side parsing shipped
  with the SharedWorker store, above).
  Interaction latency is index-served, never full-store-scanned (M5
  finding, 2026-06-12: the drill-down page froze ~25 s at 18k instances —
  one SVG node per scatter point, plus full-store scans per interaction;
  fixed by canvas-drawn scatter points and the file-rooted indexes).
- Time windows are binary-searched slices: every store-served array is
  ts-sorted, so a window (brush, sub-day range, ±5 min user context) is a
  contiguous [lo, hi) run found in O(log n) — narrow windows on huge
  stores cost what they select, not what they skip.
- Loading is automatic and as-needed: the range selection is the consent,
  at any size; progress (bytes, from the listing) is the acknowledgment.
  The store lives in a SharedWorker (2026-06-12): scan, parse, cache I/O,
  live mode, and the record store run off the main thread, in ONE worker
  shared by every tab on the origin — sessions are keyed by profile
  signature, so two tabs on the same bucket share a single working set
  and fetch pipeline (and a tab reload reattaches to a warm store).
  Tabs are thin clients (data/storeclient.ts → worker/backend.ts):
  request/response ops, store events relayed as broadcasts, worker perf
  entries streamed into each tab's perf log. Results are SAMPLED OR
  CAPPED AT THE CLONE BOUNDARY — no structured clone carries an
  unbounded array, and sampled results disclose it (the scatter pill's
  contract). Browsers without SharedWorker get a dedicated worker —
  same protocol, still off-thread, per-tab. Workspace subdomains
  (§10 hosting) compose for free: workers are origin-scoped, so each
  workspace gets its own worker, sessions, and cache with no code.
  Stream-render always: views populate as data arrives, not after the
  full scan; the plan fetches newest intervals first and works backward,
  so the freshest data appears immediately — but data events are
  adaptively throttled while a scan runs
  (each dispatch waits 5× the previous one's cost, 1–10 s), after the M5
  finding that unthrottled per-file re-renders of a growing store are
  O(n²) and froze a million-record load. The IndexedDB cache keeps repeat
  ranges near-free.
- Per-workspace limits (2026-06-13): a **memory limit** (default 256 MB) and
  a **cache limit** (default 1 GB), set on the connection form; blank = no
  limit. Two cooperating tiers back them. IndexedDB stores files
  **gzip-compressed** — fetched raw via `Range: bytes=0-` (§3.3) so the
  on-disk form is the exact stored object, ~10× smaller, with the cache limit
  accounted against the listing size and evicted LRU by display-recency (then
  older interval, then bigger). In front, an in-memory **decompressed LRU**
  (MemBytes) bounded by the memory limit holds hot bodies so parse and
  raw-line re-reads skip a re-inflate. A persistent **size ledger** records
  every file's compressed/decompressed size and per-channel compression
  ratio, OUTLIVING byte eviction — so before a load the worker estimates the
  view's in-memory cost (known sizes by key, ratios for the rest) and, if it
  exceeds the memory limit, auto-clamps the load to the newest files that fit
  and surfaces the over-budget state non-blockingly — an amber banner on the
  store inspector with a raise-the-limit recommendation, plus (per §7) a
  persistent ghost band over the intervals it couldn't load; raising the limit
  or narrowing the range clears it. (No blocking modal — that was removed
  2026-06-13.)
- **Sidecar-based sizing** (no per-file GET to plan): the S3 listing gives
  every file's *existence* (key/size/etag/interval); a file's sidecar (exact
  decompressed size + record count) is hydrated **on demand** when the budget
  needs it factual — the download estimate and the store inspector's rollups.
  The persistent size ledger retains what's been probed, so estimates are exact
  (not ratio-based) and revisits are free. Intervals stay existence-only until
  selected, so a yearlong, many-host bucket costs a listing on connect, not
  10k+ sidecar GETs. (The eager "prefetch horizon" + background sidecar fill that
  fed the old metadata volume chart were removed with it, 2026-06-14.)
- IndexedDB cache (§5) makes every revisit to finalized days free; `ETag`
  equality is the immutability check.

### 8.1 Synthetic fleet — finding the graduation point

Tracelog's pitch is "observability essentially for free, until scale makes
it impossible." That claim must ship with numbers, not vibes: a user should
be able to read in the docs roughly where the browser stops being a viable
query engine — and how to recognize when *they* are approaching it.

**The script** (`scripts/synth-fleet.mjs` in this repo — plain zero-dependency
Node so it runs without a TS toolchain; it benchmarks the viewer, and the
JSONL contract it writes against is tracelog's SCHEMA.md):

- Synthesizes a fleet of services at configurable load tiers, writing
  gzipped JSONL in the exact §3.1 key layout to a local directory (sync to
  a scratch bucket with `aws s3 sync` to exercise the full network path).
- Realism matters, because parse and memory costs depend on record shape:
  - hosts: 1–32 (an ASG worth of writers per day, including `_seq`
    overflow files at the high end);
  - traffic: log-normal duration distributions per route, a diurnal volume
    curve, configurable RPM tiers, transaction-name cardinality;
  - spans: realistic fanout per transaction (db/cache/external mixes);
  - events: app-style custom events with params, plus a client channel
    with user/device identity;
  - errors: a low base rate plus occasional bursts;
  - metricsets: runtime metrics per host at 60s cadence + breakdowns;
  - deployments: `service.version` bumps mid-range for marker rendering.
- Deterministic given a seed, so tiers are reproducible.

**The measurements**, per tier (e.g. 10k / 100k / 1M / 5M records):

- scan plan size (files, compressed/uncompressed bytes);
- cold fetch+parse wall time, warm (IndexedDB) load time once M4 lands
  (both read straight off `#/internals/perf` — copy-as-JSON, §6.8);
- heap after load (`performance.memory` in Chromium) and whether the tab
  survives;
- interaction latency on the standard moves: overview render, brush,
  filter/search in records, drill-down render, waterfall open.

**The deliverable**: a `LIMITS.md` table of tier → load time → memory →
UX verdict, summarized in the README ("comfortable to N records / ~X MB
per month; degraded to Y; graduate beyond that"), re-run when the store
changes (e.g. if §8's columnar contingency is ever built). The same
numbers double as guidance for when a user should narrow scans by channel
or date rather than abandon tracelog entirely.

## 9. Milestones

1. **M1 — plumbing**: config panel, channel discovery, date-range scan,
   fetch+parse+store, raw record table with filters. (Already useful.)
2. **M2 — APM**: transactions view, trace waterfall, overview dashboard.
3. **M3 — operations**: events/errors view with user-context drilldown,
   metrics view, live mode.
4. **M4 — polish**: client analytics, scanner view, IndexedDB cache,
   shareable hash-URLs encoding scan + view state.
5. **M5 — scale validation**: the synthetic fleet script and LIMITS.md
   (§8.1) — publish the measured graduation point alongside the
   open-source release.

## 10. Decisions (resolved 2026-06-11)

- **Hosting** (LIVE 2026-06-12, scripts/deploy-site.mjs — a turnkey
  provision-or-adopt deployer anyone can point at their own account):
  localhost for development; the public deployment is **tracelog.org** as an S3 + CloudFront static site
  with a wildcard cert (`*.tracelog.org`), every subdomain serving the
  identical bytes. Because origins partition browser storage, each
  subdomain is a free, fully client-side **workspace**: visiting
  `alpha.tracelog.org` vs `beta.tracelog.org` yields separate
  localStorage profiles and separate IndexedDB caches with zero
  server-side tenancy — the server knows nothing. Users' log buckets
  allow `https://*.tracelog.org` in CORS (S3 permits one wildcard per
  origin) alongside localhost. Self-hosting is first-class: the same
  static `dist/` works from any bucket/domain for anyone who prefers not
  to trust the hosted instance, or who forks. No cookies, ever — they are
  the one storage that could leak across subdomains (§4 already forbids
  them).
- **Workspaces are always subdomains; the apex is not one** (2026-06-12):
  `tracelog.org` is the public landing (About) + directory keeper only —
  no profiles or data live there, it shows About for every view, and the
  switcher there is purely a launcher (pick a workspace or make a new
  one). Creating a workspace provisions *nothing* — no DNS record, no
  cloud service, no account; the wildcard subdomain already resolves for
  everyone, and a workspace is just a separate corner of this one browser
  (the new-workspace modal says so).
- **Public buckets** (2026-06-13): a connection can be marked public —
  the form hides all auth fields, LogBucket issues *unsigned* requests
  (no-op SigV4 signer + placeholder creds to skip the credential chain),
  and saving in public mode clears any stored credentials. Requires the
  bucket policy to allow anonymous `ListBucket` + `GetObject`.
- **Credential persistence is opt-in** (SPEC §4): a connection lives only
  in the tab's memory unless "Remember on this device" is checked, which
  writes it to localStorage. Public buckets carry nothing sensitive. Each
  workspace's config has an obvious **Purge** that wipes its connection,
  its IndexedDB cache, and its directory entry — the only persistent
  surfaces this origin has.
- **Optional bucket prefix** (2026-06-13): a connection may set a key
  prefix (e.g. `logs/`) when the tracelog channels live below the bucket
  root rather than at it. Encapsulated entirely in `LogBucket` — it's
  prepended to every list/fetch and stripped from returned keys, so
  parseKey, the store, the scanner, and the cache keep working with
  logical `channel/interval/host` keys. Whatever the user types
  (leading/trailing/internal slashes, blank) is canonicalized by
  `normalizePrefix` to `''` or `a/b/`.
- **One connection per workspace** (2026-06-12): there is no profile
  *name* — the subdomain is the namespace, so a workspace connects to one
  bucket. Want a second namespace? Make a second workspace
  (`acme-staging`). profiles.ts is a single-profile-per-origin store
  (migrates the old multi-profile array to its active/first entry).
- **Workspace switcher** (2026-06-12, navigation-based): the masthead pill
  shows the current workspace; its menu edits this workspace's connection
  and hops to the other workspaces (navigate to their subdomain). Since
  origins are siloed, the one shared thing is a directory of workspace
  *names*, kept in the **apex** origin's first-party localStorage.
  Subdomains never reach into apex storage directly (no iframe — nothing
  an ad-blocker or privacy mode can impede); they **navigate** to the
  apex's relay route (`#/relay`, `data/workspaces.ts` `handleWorkspaceBoot`),
  which does the read/write first-party and bounces straight back, carrying
  a fresh snapshot in the return hash (`wsr=1` one-shot marker → cache +
  set the synced flag, and guarantees no re-bounce loop). Each subdomain
  keeps a local cached snapshot for instant switcher hops. Transits: a
  **first visit** auto-syncs read-only (no record); **creating** a profile
  records the workspace (apex-first for the switcher's New-workspace flow,
  or save-time for a directly-visited subdomain); **deleting** the last
  profile drops it; a manual **Sync** refreshes on demand. Names only:
  never credentials, never logs, no cookies — "the server knows nothing"
  holds, and the directory is inherently per-device. Profiles carry a
  `subdomain` field (= the origin they live at). Hosts with no apex
  (localhost, self-host single-domain) skip all of it and degrade to a
  local-only profile switcher.
- **Theme**: light **and** dark from day one, token-based (§7), defaulting
  to `prefers-color-scheme` with a manual toggle.
- **Profiles for other services**: yes — config supports arbitrary
  bucket/region/credentials profiles from day one; nothing service-specific
  is hard-coded except display defaults (channel names, client-analytics
  event types).
- **Timezone display**: render local time, with a UTC toggle in the header;
  axis and table headers always state which is active (e.g. `14:05 PDT` /
  `21:05 UTC`).
- **The old archive** (pre-2026-06-11 flat-layout logs in
  `~/Downloads/ddd-log-audit`): out of scope. A "load from local directory"
  escape hatch (File System Access API) remains a possible post-M4 idea,
  noted here so it isn't forgotten.
- **UX before plumbing** (2026-06-12): the app is oriented around the
  user's questions, not its own mechanics — "files" are a managed detail,
  surfaced only in the store inspector. Concretely: setting a range is the
  consent — loading is automatic at any size with progress as the only
  acknowledgment (large-download confirmation removed 2026-06-13); chrome
  copy counts records and bytes rather than files; and future features
  should prefer "the app handled it" over "the app asked me about it".

## 11. The aggregate solver (planned)

A query-planning layer that lets the worker answer a chart's question the
cheapest way available — from a sidecar index, an in-memory index, or a full
scan of loaded records — while the caller stays blind to which. It is the formal
home for the responsibility boundary set in §6.1: **the front end states *what*
it wants; the worker decides *how*.** No chart ever learns whether its numbers
came from metadata or records (the "· from metadata" label was removed
2026-06-14); a chart asks for a result and gets a result, plus an honest mark of
where the result is incomplete.

### 11.1 Two request shapes

Everything a view needs is one of two requests:

1. **An aggregate** — a metric tallied into time buckets, e.g.
   `COUNT(record)`, `SUM(duration)`, `MAX(heap)`, optionally grouped by a
   dimension (`SUM(duration) GROUP BY transaction`). Feeds bar/line charts.
2. **A filtered record set** — the actual matching rows, e.g. every
   transaction in a range for the duration scatter or a table.

The distinction matters because only aggregates can ever be served *without the
rows*. A record-set request needs the rows by definition — an index can only
help *plan* it (which intervals have matches, how many, whether within budget,
and therefore where the ghost band falls), never replace it.

### 11.2 What an index can satisfy: the decomposability algebra

Whether an aggregate can be answered from per-interval summaries — rather than
re-scanning records — depends on how it composes when intervals are merged (the
data-cube taxonomy):

- **Distributive** — `COUNT`, `SUM`, `MIN`, `MAX`. A range's answer is the
  direct merge of its intervals' answers (sum of sums, max of maxes). Trivially
  index-friendly.
- **Algebraic** — `AVG`, variance, stddev. Computable from a *bounded set* of
  distributive parts (`AVG` = `SUM`/`COUNT`; stddev = `SUM`, `SUM²`, `COUNT`).
  Index-friendly **only if the index stores those parts**, not the derived
  number — an index of pre-averaged values cannot be re-merged correctly.
- **Holistic** — exact percentiles (`p95`), `COUNT(DISTINCT)`, median. *Not*
  reconstructable from fixed-size per-interval summaries. Servable from an index
  only if it stores **mergeable sketches** (t-digest for quantiles, HyperLogLog
  for distinct counts); otherwise the request falls to a scan.

The solver's job is exactly this membership test: is the requested metric in the
closure of the available indexes under interval-merge?

### 11.3 The solver

Each index *advertises a capability*: which metrics it holds, grouped by which
dimensions, at what time granularity, over which intervals. Each request
*declares a need*: a metric, a grouping, a bucket size, a range. The solver
matches them on three axes:

- **Metric** — the need is in the index's closure (§11.2).
- **Granularity** — an index rolls up *finer → coarser* only (an hourly index
  serves buckets ≥ 1h; it can never synthesize a 5-minute bar).
- **Grouping & coverage** — the index is pre-grouped by the requested dimension
  (or a parent it can roll up), and actually covers the interval.

The result is a *plan* that partitions the range into three interval sets:
`fromIndex` (answered from the index), `scan` (records loaded and tallied), and
`ghost` (coverable by neither — not in any index, not loaded, or budget-refused).
The honesty invariant is that these three **partition the range exactly** — which
means **the ghost band is a derivation of the plan, not a special case bolted
on.** Today **no index is registered**, so every aggregate scans the loaded
records and the uncovered remainder (budget-refused intervals) is ghosted —
`solveSeriesAggregate` in `backend.ts`. (An earlier `COUNT[kind]@hourly`
sidecar index served the old volume chart from metadata; it was retired with
that chart on 2026-06-14, since the duration-by-transaction overview can't be
satisfied from the kind-only sidecar. Re-registering a per-transaction index is
the schema-on-read work below.)

### 11.4 Build order (each step earns the next)

1. **Source-agnostic contract** *(done, 2026-06-14)*. The query op returns only
   the tally plus completeness (`ghostSpans` + a `complete` boolean); the view
   renders tally + ghost and reasons about neither records nor index. This is
   the seam the solver slots into.
2. **A `Metric` type and the solver** *(done)*. The chart sends a declarative
   `{ metric, groupBy, bucketMs, range }`; the solver dispatches on it. The
   contract is deliberately duplicated UI/worker (`query.ts`) while it
   stabilizes, ahead of extracting the worker as its own library.
3. **The redesigned overview chart** *(done, 2026-06-14)* — Σ-duration by
   transaction. The chart shows a *selectable* set of transactions, each its own
   colored band (no "Other"): it defaults to the top-N by total, and the
   transaction table is its legend — a colored toggle per row adds/removes any
   transaction (even off the top-N) with a stable auto-assigned color. No index
   advertises this metric, so the solver scans loaded records with ghost bands:
   correct from day one, just not yet cheap.
4. **Consumer-side durable indexes** *(done, 2026-06-15)* — per-file parse-time
   rollups that outlive the byte cache (the schema-on-read index plan).
   `data/txnindex.ts` rolls up transaction COUNT + Σ duration by transaction name
   per UTC hour, built at parse time and persisted in its own IndexedDB store
   (`txnindex`, DB v5) keyed by file+ETag — so it survives byte eviction (parse
   once, keep the rollup, drop the bytes). The solver (`solveSeriesAggregate`)
   now **matches**: each selected file is served from its index when it's not
   loaded, lies fully inside the range, is ETag-valid, and the grid is ≥1h and
   hour-aligned — otherwise its loaded records are scanned. The two sources merge
   through `aggregateBySeries`'s `extra` weighted-points input (a record and an
   equivalent index point produce the identical tally — verified by test), and an
   index-covered interval no longer blanks or ghosts. So an over-budget range now
   shows real bars from the index where it used to show only ghost — **with no
   change to any chart** (they ask declaratively). An index is always an
   optimization, never a correctness
   requirement — drop every index and the answers are identical, only slower.

### 11.5 Philosophy

- **Declarative separation.** A chart names a question; it never encodes a
  retrieval strategy. That is what lets the strategy improve underneath it
  forever without touching a view.
- **Optimization, never correctness.** The scan path is the ground truth and is
  always available; indexes only let the solver *skip* work it could otherwise
  do the slow way. A stale or missing index degrades performance, never
  accuracy.
- **Honesty by construction.** Completeness is part of the answer, and the ghost
  band is the plan's uncovered remainder — so a chart cannot accidentally
  present a partial result as whole.
- **Heuristics from the shape of the data.** Observability is a domain with
  *characteristic* data shapes, and the solver and its indexes should exploit
  them rather than treat the data as arbitrary:
  - **Heavy-tailed grouping.** A REST service has tens of transaction names, not
    thousands; load and time concentrate in a handful. So a top-N + "other"
    rollup is a near-lossless index for the questions people actually ask, and
    high-cardinality dimensions (user/session IDs) are deliberately *not*
    indexed.
  - **Immutability.** A finalized log object never changes, so a per-file index
    is correct forever once built — compute it once, keep the tiny rollup after
    evicting the heavy bytes (cf. `ledger.ts`).
  - **Time locality & recency bias.** Queries cluster on recent windows and scan
    contiguous ranges; interval-aligned, recent-first indexes pay off, and a
    bounded working set keeps memory in check (§8).
  - **Bounded categorical cardinality.** Record kinds are a fixed set of five —
    cheap enough that the sidecar *manifest* can carry a `COUNT GROUP BY kind`
    histogram essentially for free, while richer, higher-cardinality breakdowns
    (by transaction, host) stay consumer-side.
  Good heuristics here are not generic database tricks; they come from knowing
  what telemetry *looks like*.
