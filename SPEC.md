# tracelog-viewer — SPEC

An entirely in-browser APM and log viewer for tracelog buckets. A static web
page — no server, no backend, no third party — that fetches gzipped JSONL log
files directly from S3 using user-supplied AWS credentials, decompresses them
in the browser, and renders dedicated APM visualizations with D3.

At DuiDuiDui's scale (tens of MB of compressed logs per month after the June
2026 verbosity cleanup), the entire working set for any reasonable query fits
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

Tracked as duiduidui-infra work; the viewer assumes both are in place:

1. **CORS configuration** on the logs bucket permitting the viewer's origin
   (and `http://localhost:*` for development):

   ```json
   {
     "CORSRules": [{
       "AllowedOrigins": ["https://<viewer-origin>", "http://localhost:5173"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag", "Content-Length", "Last-Modified"],
       "MaxAgeSeconds": 3600
     }]
   }
   ```

   Note `ListObjectsV2` is a GET on the bucket URL, so this single rule
   covers listing and fetching.

2. **A dedicated read-only IAM user** for the viewer, scoped to the logs
   bucket only (`s3:GetObject`, `s3:ListBucket` on
   `arn:aws:s3:::duiduidui-prod-logs[/*]`). Never paste an admin key into a
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

- **channel** — top-level prefix. DuiDuiDui prod channels: `server`
  (the default channel), `client` (mobile-app logs relayed via POST /logs),
  `unknown-route` (internet-scanner noise diverted by transaction routing).
  New channels can appear at any time; the viewer must discover, not assume.
- **interval** — `YYYY-MM-DD` for daily rotation (the only schedule DuiDuiDui
  uses today); hourly rotation would produce `YYYY-MM-DDTHH`. Lexicographic
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

- Objects are uploaded with `Content-Encoding: gzip`, so browsers decompress
  transparently on `fetch`. Implementation must not double-gunzip: check the
  response, and fall back to `DecompressionStream('gzip')` only when the body
  is still compressed (e.g. a proxy stripped the header).
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

Verified against the live `duiduidui-prod-logs` bucket on day one of the
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
  outcome (duiduidui-server passes explicit results as of the 1.7.0
  integration), so outcome rollups are trustworthy across both conventions.
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
             store.ts         — in-memory record store + indexes (by kind, trace_id,
                                transaction name, event type/level, time buckets)
             cache.ts         — IndexedDB cache of *finalized* files keyed by
                                S3 key + ETag (immutable, so cache forever);
                                _current files are never cached
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
("12,345 records · 48 MB") links to the store inspector, the opt-in page
where file-level detail (per-file sizes, counts, eviction) lives.

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

The client channel cut by `user.id` / device: sessions (gaps > 15 min),
app versions in the wild, slow-query perf events (everything ≥ the 100 ms
client threshold), review-session funnels from lifecycle events. This view
is DuiDuiDui-specific in its defaults but generic in mechanism (group by
`event.type`).

### 6.7 Scanner traffic (unknown-route)

A deliberately small view: probes per day, top requested paths, top user
agents. Mostly entertainment; excluded from all other rollups.

---

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
  *keys* but never values), and lazy raw — records keep their original
  NDJSON line as a sliced string plus small eagerly-extracted normalized
  fields, re-parsing on demand for the drawer. Next on the ladder if the
  M5 measurements call for it: columnar typed arrays per kind.
- Loading is automatic and as-needed: the range selection is the consent,
  at any size; progress (bytes, from the listing) is the acknowledgment.
  Stream-render always: views populate as data arrives, not after the
  full scan. The IndexedDB cache keeps repeat ranges near-free.
- IndexedDB cache (§5) makes every revisit to finalized days free; `ETag`
  equality is the immutability check.

### 8.1 Synthetic fleet — finding the graduation point

Tracelog's pitch is "observability essentially for free, until scale makes
it impossible." That claim must ship with numbers, not vibes: a user should
be able to read in the docs roughly where the browser stops being a viable
query engine — and how to recognize when *they* are approaching it.

**The script** (`scripts/synth-fleet.ts` in this repo — it benchmarks the
viewer, and the JSONL contract it writes against is tracelog's SCHEMA.md):

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
- cold fetch+parse wall time, warm (IndexedDB) load time once M4 lands;
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

- **Hosting** (revised 2026-06-12): localhost for development; the public
  deployment plan is **tracelog.org** as an S3 + CloudFront static site
  with a wildcard cert (`*.tracelog.org`), every subdomain serving the
  identical bytes. Because origins partition browser storage, each
  subdomain is a free, fully client-side **workspace**: visiting
  `duiduidui.tracelog.org` vs `shaxpir.tracelog.org` yields separate
  localStorage profiles and separate IndexedDB caches with zero
  server-side tenancy — the server knows nothing. Users' log buckets
  allow `https://*.tracelog.org` in CORS (S3 permits one wildcard per
  origin) alongside localhost. Self-hosting is first-class: the same
  static `dist/` works from any bucket/domain for anyone who prefers not
  to trust the hosted instance, or who forks. No cookies, ever — they are
  the one storage that could leak across subdomains (§4 already forbids
  them).
- **Theme**: light **and** dark from day one, token-based (§7), defaulting
  to `prefers-color-scheme` with a manual toggle.
- **Profiles for other services**: yes — config supports arbitrary
  bucket/region/credentials profiles from day one; nothing DuiDuiDui-specific
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
