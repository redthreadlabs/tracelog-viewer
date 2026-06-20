#!/usr/bin/env node
/**
 * Synthetic log-data generator (SPEC §8.1) — writes gzipped tracelog JSONL in
 * the exact §3.1 key layout so the viewer can be explored against data that
 * looks like a real startup's deployment, not a benchmark.
 *
 * The model: a small product backend of FOUR services, each its own channel
 * (public-api, auth-service, analytics-service, media-service), plus a `client`
 * channel (mobile/web app events + client traces, joined to per-launch origins)
 * and an `unknown-route` channel
 * (internet-scanner noise hitting the public API). Each service has its own
 * endpoints and dependency profile (postgres/redis/clickhouse/kafka/s3/cdn), and
 * requests to the public API fan out to the others as **distributed traces**: a
 * single trace_id spans channels, with each downstream service's transaction
 * parented to the caller's exit span (the viewer stitches the waterfall when you
 * load multiple channels).
 *
 * Realism: ~3 active hosts per service with rolling replacement (a deploy every
 * few days retires one host, adds one, and bumps the service version → real
 * deployment markers); a diurnal curve × weekday/weekend dip × gentle
 * month-long growth; and one incident (an error-rate spike) during the window.
 *
 * Zero dependencies; deterministic for a given seed.
 *
 *   node scripts/generate-synthetic-log-data.mjs --out DIR [--records 1000000]
 *       [--seed 20260612] [--weeks 4] [--end 2026-06-14] [--services a,b]
 *
 * `--records` is the approximate TOTAL across all channels; re-run with
 * `--records 10000000` for the same 4-week deployment at 10× density. Every day
 * is in the past → every file is finalized (no `_current`), exercising the cache.
 *
 * Upload — TWO syncs, because the headers differ (sidecars are plain JSON,
 * never gzip-encoded):
 *   AWS_PROFILE=... aws s3 sync DIR s3://BUCKET \
 *     --exclude "*.meta.json" --content-encoding gzip --content-type application/x-ndjson
 *   AWS_PROFILE=... aws s3 sync DIR s3://BUCKET \
 *     --exclude "*" --include "*.meta.json" --content-type application/json
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

// The sidecar histogram is built with the SAME canonical code the agent uses,
// so the sample data's metadata matches the real contract exactly.
const require = createRequire(import.meta.url);
const { MetaAccumulator, sidecarKey } = require('@redthreadlabs/tracelog-schema');

// ---------------------------------------------------------------- CLI args

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) =>
    a.startsWith('--') ? [a.slice(2), all[i + 1]] : null,
  ).filter(Boolean),
);
const OUT = args.out;
if (!OUT) {
  console.error('usage: node scripts/generate-synthetic-log-data.mjs --out DIR [--records N] [--seed N] [--weeks N] [--end YYYY-MM-DD] [--services a,b]');
  process.exit(1);
}
const SEED = Number(args.seed ?? 20260612);
const TARGET = Number(args.records ?? 1_000_000);
const WEEKS = Number(args.weeks ?? 4);
const TOTAL_DAYS = WEEKS * 7;
const END_INTERVAL = args.end ?? '2026-06-14'; // last (most recent) generated interval
const SERVICE_FILTER = args.services ? new Set(args.services.split(',')) : null;

// Budget split (fractions of TARGET). Server request traffic dominates; client
// telemetry and host metricsets fill the rest. Scales with --records.
const SERVER_FRAC = 0.72;
const CLIENT_FRAC = 0.16;
const METRICSET_FRAC = 0.12;

const MAX_FILE_BYTES = 12 * 1024 * 1024; // uncompressed, per file → _seq overflow

// --------------------------------------------------------- deterministic RNG

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const HEX = '0123456789abcdef';
function makeTools(rng) {
  return {
    rng,
    hex: (n) => {
      let s = '';
      for (let i = 0; i < n; i++) s += HEX[(rng() * 16) | 0];
      return s;
    },
    normal: () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng()),
    pick: (arr) => arr[(rng() * arr.length) | 0],
    int: (lo, hi) => lo + ((rng() * (hi - lo + 1)) | 0),
    // weighted pick over [{w, ...}]
    weighted: (arr, total) => {
      let acc = rng() * total;
      for (const x of arr) if ((acc -= x.w) < 0) return x;
      return arr[arr.length - 1];
    },
  };
}
// one global generator drives everything (deterministic for the seed)
const t = makeTools(mulberry32(SEED));

// ---------------------------------------------------- dependency span types

const SPAN_TYPES = {
  pg: { type: 'db', subtype: 'postgresql', action: 'query',
    names: ['SELECT FROM users', 'SELECT FROM content', 'INSERT INTO purchases', 'UPDATE sessions', 'SELECT FROM assets'],
    dest: { address: 'pg.internal', port: 5432 } },
  redis: { type: 'db', subtype: 'redis', action: 'exec',
    names: ['GET', 'SET', 'EXPIRE', 'MGET'],
    dest: { address: 'cache.internal', port: 6379 } },
  clickhouse: { type: 'db', subtype: 'clickhouse', action: 'query',
    names: ['SELECT events', 'INSERT events', 'SELECT funnel'],
    dest: { address: 'clickhouse.internal', port: 8123 } },
  kafka: { type: 'messaging', subtype: 'kafka', action: 'send',
    names: ['produce events', 'produce metrics'],
    dest: { address: 'kafka.internal', port: 9092 } },
  s3: { type: 'storage', subtype: 's3', action: undefined,
    names: ['S3 GetObject media-prod', 'S3 PutObject media-prod'],
    dest: { address: 's3.amazonaws.com', port: 443 } },
  cdn: { type: 'external', subtype: 'http', action: undefined,
    names: ['POST imgix.net', 'PURGE cdn.example.com'],
    dest: { address: 'cdn.example.com', port: 443 } },
};

// ------------------------------------------------------------- the services
// weight = share of ROOT (entry) requests. public-api is the front door; the
// others get a little direct traffic (health, internal) but mostly run as
// downstream calls. Each route: w (mix), med ms, sigma, err rate, user prob,
// local deps (span keys), and `calls` (downstream {to service, route, p}).

const SERVICES = {
  'public-api': {
    weight: 88,
    routes: [
      { name: 'GET /v1/feed', w: 14, med: 55, sig: 0.7, err: 0.004, user: 0.95, local: ['pg', 'redis'], calls: [{ to: 'analytics-service', route: 'POST /ingest', p: 0.5 }] },
      { name: 'GET /v1/users/:id', w: 10, med: 22, sig: 0.6, err: 0.002, user: 1, local: ['pg', 'redis'], calls: [] },
      { name: 'POST /v1/sessions', w: 7, med: 95, sig: 0.7, err: 0.012, user: 0.4, local: ['redis'], calls: [{ to: 'auth-service', route: 'POST /token', p: 1 }] },
      { name: 'GET /v1/content/:id', w: 12, med: 30, sig: 0.6, err: 0.002, user: 0.7, local: ['pg', 'redis'], calls: [{ to: 'media-service', route: 'GET /assets/:id', p: 0.6 }] },
      { name: 'POST /v1/purchases', w: 4, med: 180, sig: 0.8, err: 0.015, user: 1, local: ['pg', 'pg'], calls: [{ to: 'auth-service', route: 'GET /introspect', p: 1 }, { to: 'media-service', route: 'POST /uploads', p: 0.15 }] },
      { name: 'GET /v1/search', w: 8, med: 130, sig: 0.9, err: 0.005, user: 0.6, local: ['redis'], calls: [{ to: 'analytics-service', route: 'GET /metrics', p: 0.3 }] },
      { name: 'POST /v1/events', w: 6, med: 14, sig: 0.5, err: 0.001, user: 0.8, local: [], calls: [{ to: 'analytics-service', route: 'POST /batch', p: 1 }] },
      { name: 'GET /healthz', w: 16, med: 2, sig: 0.3, err: 0.0001, user: 0, local: [], calls: [] },
    ],
    scanner: true,
  },
  'auth-service': {
    weight: 5,
    routes: [
      { name: 'POST /token', w: 10, med: 35, sig: 0.6, err: 0.006, user: 0.4, local: ['pg', 'redis'], calls: [] },
      { name: 'POST /token/refresh', w: 8, med: 18, sig: 0.5, err: 0.004, user: 0.6, local: ['redis'], calls: [] },
      { name: 'GET /introspect', w: 12, med: 8, sig: 0.4, err: 0.001, user: 0.5, local: ['redis'], calls: [] },
      { name: 'POST /login', w: 5, med: 110, sig: 0.7, err: 0.02, user: 0.3, local: ['pg', 'redis'], calls: [] },
      { name: 'GET /healthz', w: 10, med: 2, sig: 0.3, err: 0, user: 0, local: [], calls: [] },
    ],
  },
  'analytics-service': {
    weight: 4,
    routes: [
      { name: 'POST /ingest', w: 16, med: 12, sig: 0.6, err: 0.002, user: 0, local: ['clickhouse', 'kafka'], calls: [] },
      { name: 'POST /batch', w: 5, med: 240, sig: 0.9, err: 0.006, user: 0, local: ['clickhouse', 'clickhouse', 'kafka'], calls: [] },
      { name: 'GET /metrics', w: 8, med: 160, sig: 0.8, err: 0.003, user: 0.5, local: ['clickhouse', 'redis'], calls: [] },
      { name: 'GET /funnels', w: 3, med: 520, sig: 1.0, err: 0.008, user: 1, local: ['clickhouse', 'clickhouse'], calls: [] },
      { name: 'GET /healthz', w: 10, med: 2, sig: 0.3, err: 0, user: 0, local: [], calls: [] },
    ],
  },
  'media-service': {
    weight: 3,
    routes: [
      { name: 'GET /assets/:id', w: 14, med: 40, sig: 0.7, err: 0.003, user: 0.5, local: ['s3', 'redis'], calls: [] },
      { name: 'POST /uploads', w: 6, med: 420, sig: 0.9, err: 0.01, user: 1, local: ['s3', 'pg'], calls: [] },
      { name: 'POST /transcode', w: 3, med: 1500, sig: 1.0, err: 0.02, user: 1, local: ['s3', 'cdn'], calls: [] },
      { name: 'GET /healthz', w: 10, med: 2, sig: 0.3, err: 0, user: 0, local: [], calls: [] },
    ],
  },
};
const SERVICE_NAMES = Object.keys(SERVICES);
for (const [name, svc] of Object.entries(SERVICES)) {
  svc.name = name;
  svc.routeW = svc.routes.reduce((s, r) => s + r.w, 0);
}
const SERVICE_W = SERVICE_NAMES.reduce((s, n) => s + SERVICES[n].weight, 0);

// ------------------------------------------------------- client + misc pools

const SCANNER_PATHS = [
  '/.env', '/wp-login.php', '/xmlrpc.php', '/admin/config.php', '/.git/config',
  '/cgi-bin/luci', '/owa/auth/logon.aspx', '/phpmyadmin/index.php', '/actuator/health',
  '/boaform/admin/formLogin', '/.aws/credentials', '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php',
];
const SCANNER_AGENTS = [
  'zgrab/0.x', 'python-requests/2.32', 'Go-http-client/1.1', 'curl/8.5.0',
  'Mozilla/5.0 (compatible; CensysInspect/1.1)', 'masscan/1.3', 'Mozilla/5.0 zgrab/0.x',
];
const EVENT_TYPES = [
  { type: 'page_view', w: 9 }, { type: 'purchase', w: 2 },
  { type: 'feature_used', w: 6 }, { type: 'signup', w: 1 },
  { type: 'share', w: 2 }, { type: 'notification_open', w: 3 },
  { type: 'log', w: 4 },
];
const EVENT_W = EVENT_TYPES.reduce((s, e) => s + e.w, 0);
// client trace flows: a root transaction (type 'app') with child spans
const PERF_FLOWS = [
  { root: 'app launch', children: ['load config', 'fetch feed', 'render feed'], med: 900, sig: 0.5 },
  { root: 'open content', children: ['fetch content', 'fetch media', 'render'], med: 600, sig: 0.6 },
  { root: 'checkout', children: ['create session', 'submit purchase', 'render receipt'], med: 1400, sig: 0.6 },
  { root: 'search', children: ['query', 'render results'], med: 500, sig: 0.7 },
];
const DEVICES = [
  { model: 'iPhone 15 Pro', brand: 'Apple', os: 'iOS', osv: '18.5' },
  { model: 'iPhone 13', brand: 'Apple', os: 'iOS', osv: '17.6' },
  { model: 'Pixel 9', brand: 'Google', os: 'Android', osv: '15' },
  { model: 'SM-S938B', brand: 'Samsung', os: 'Android', osv: '15' },
  { model: 'iPad Air', brand: 'Apple', os: 'iOS', osv: '18.5' },
];
// Client locale ↔ per-event tz_offset (minutes east of UTC), as the client SDK
// records — a spread of zones exercises the viewer's time-zone display.
const LOCALE_TZ = [
  { locale: 'en-US', tz: -300 }, { locale: 'en-US', tz: -420 }, { locale: 'en-US', tz: -480 },
  { locale: 'zh-Hans-CN', tz: 480 }, { locale: 'es-MX', tz: -360 }, { locale: 'de-DE', tz: 60 },
];
const ERROR_SHAPES = [
  { type: 'ConnectionError', msg: 'connection timed out after 30000 ms', code: undefined },
  { type: 'TypeError', msg: "Cannot read properties of undefined (reading 'id')", code: undefined },
  { type: 'Error', msg: 'socket hang up', code: 'ECONNRESET' },
  { type: 'RangeError', msg: 'Maximum call stack size exceeded', code: undefined },
  { type: 'Error', msg: 'connect ETIMEDOUT 34.117.59.81:443', code: 'ETIMEDOUT' },
];
const FRAME_FILES = [
  ['lib/routes/feed.js', 'getFeed'], ['lib/routes/users.js', 'getUser'],
  ['lib/db/pool.js', 'withClient'], ['lib/services/media.js', 'fetchAsset'],
  ['node_modules/pg/lib/client.js', 'query'],
  ['node_modules/express/lib/router/index.js', 'handle'],
];
const USERS = Array.from({ length: 600 }, (_, i) => `user-${String(i + 1).padStart(4, '0')}`);

// ------------------------------------------------------------ traffic curves

// Diurnal traffic curve, peak ~16:00 UTC.
const HOUR_W = Array.from({ length: 24 }, (_, h) =>
  0.3 + 0.7 * (1 + Math.cos(((h - 16) / 24) * 2 * Math.PI)) / 2);
const HOUR_W_SUM = HOUR_W.reduce((a, b) => a + b, 0);

function dowOf(intervalMs) {
  return new Date(intervalMs).getUTCDay(); // 0 = Sun
}
// weekday full, weekend dip
function weeklyWeight(intervalMs) {
  const d = dowOf(intervalMs);
  return d === 0 || d === 6 ? 0.62 : 1.0;
}
// gentle month-long growth: ramps from 0.7× to 1.3× across the window
function growthWeight(dayIdx) {
  return TOTAL_DAYS <= 1 ? 1 : 0.7 + 0.6 * (dayIdx / (TOTAL_DAYS - 1));
}

function intervalLabel(endInterval, back) {
  const [y, m, d] = endInterval.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d) - back * 86400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

// the incident: one service sees a ~30-min error-rate spike on a mid-window day
const INCIDENT = (() => {
  const dayIdx = 2 + ((t.rng() * (TOTAL_DAYS - 4)) | 0); // not the very edges
  const service = t.pick(['public-api', 'media-service', 'analytics-service']);
  const startHour = t.int(13, 19); // during the busy part
  return { dayIdx, service, startMs: startHour * 3600_000, durMs: 30 * 60_000, mult: 22 };
})();

// ------------------------------------------------- host churn (rolling fleet)
// Each service runs ~3 hosts; every ~4 days a deploy retires the oldest, adds a
// new one, and bumps the version — so the fleet rolls and the metrics view shows
// real deployment markers. Returns perDay[dayIdx] = { hosts: [...], version }.

const DEPLOY_EVERY_DAYS = 4;
function buildFleet(serviceIdx) {
  let nextNum = 21;
  const newHost = () => `10.${serviceIdx}.0.${nextNum++}`;
  let active = [newHost(), newHost(), newHost()];
  let minor = 0;
  let patch = 0;
  const perDay = [];
  for (let d = 0; d < TOTAL_DAYS; d++) {
    if (d > 0 && d % DEPLOY_EVERY_DAYS === 0) {
      active = [...active.slice(1), newHost()]; // retire oldest, add new
      if (++patch > 5) { patch = 0; minor++; }
    }
    perDay.push({ hosts: [...active], version: `1.${minor}.${patch}` });
  }
  return perDay;
}
const FLEET = {};
SERVICE_NAMES.forEach((name, i) => { FLEET[name] = buildFleet(i); });

// --------------------------------------------------------- record generation
//
// All records for a day are accumulated into bucket[channel][host] = [{ts,line}]
// then written together, so a distributed trace's records reach the right
// per-service files even though they're produced as one tree.

let bucket; // reset per day

// Client lifetimes: a launch of the mobile/web app. Each emits its RecordOrigin
// ONCE (an in-stream `metadata` record keyed by lifetime_id), then events +
// client traces that carry that lifetime_id; the viewer joins them to resolve
// device / os / app version. A rolling pool (some lifetimes persist across days)
// means a lifetime's origin can sit in an EARLIER interval than its later
// records — exercising the origin index + backward-hop resolver.
const emittedOrigins = new Set();
let lifetimePool = [];

function emit(channel, host, ts, obj) {
  const perHost = (bucket[channel] ??= {});
  (perHost[host] ??= []).push({ ts, line: JSON.stringify(obj) });
}

function spanRecord(channel, host, traceId, txnId, depKey, tsMs, durMs) {
  const dep = SPAN_TYPES[depKey];
  const tsUs = Math.round(tsMs * 1000);
  emit(channel, host, tsUs, { span: {
    id: t.hex(16), trace_id: traceId, transaction_id: txnId, parent_id: txnId,
    name: t.pick(dep.names), type: dep.type,
    ...(dep.subtype && { subtype: dep.subtype }),
    ...(dep.action && { action: dep.action }),
    duration: Math.round(durMs * 1000) / 1000, timestamp: tsUs,
    sync: false, outcome: 'success',
    context: {
      ...(dep.type === 'db' && { db: { type: dep.subtype, instance: 'prod' } }),
      destination: { address: dep.dest.address, port: dep.dest.port,
        service: { resource: `${dep.subtype}/${dep.dest.address}` } },
    },
  } });
}

// Generate one transaction (entry or downstream) and its tree. `inbound`, when
// present, is the caller's exit span — the new transaction parents to it and
// shares the trace_id, producing a cross-channel distributed trace.
function makeTransaction(svc, route, host, tsMs, version, errMult, traceId, inbound) {
  traceId = traceId ?? t.hex(32);
  const txnId = t.hex(16);
  const dur = Math.min(30_000, Math.max(0.4, Math.exp(Math.log(route.med) + route.sig * t.normal())));
  const failed = t.rng() < route.err * errMult;
  const clientErr = !failed && t.rng() < 0.03;
  const status = failed ? 500 : clientErr ? t.pick([400, 404, 404]) : 200;
  const userId = t.rng() < route.user ? t.pick(USERS) : null;
  const method = route.name.split(' ')[0];
  const path = route.name.split(' ')[1] ?? '/';

  // local dependency spans, walking a fraction of the transaction's elapsed time
  let cursor = 0.05 + t.rng() * 0.1;
  for (const depKey of route.local) {
    if (t.rng() > 0.94) continue; // occasionally a dep is skipped
    const frac = (0.8 - cursor) * (0.15 + t.rng() * 0.4);
    spanRecord(svc.name, host, traceId, txnId, depKey, tsMs + dur * cursor, Math.max(0.2, dur * frac));
    cursor += frac + 0.02;
  }

  // downstream service calls → an exit span here + the callee's transaction in
  // its own channel (shared trace_id), i.e. a distributed trace
  let started = route.local.length;
  for (const call of route.calls) {
    if (t.rng() > call.p) continue;
    const callee = SERVICES[call.to];
    const calleeRoute = callee.routes.find((r) => r.name === call.route) ?? callee.routes[0];
    const calleeHost = t.pick(fleetOn(call.to, CUR_DAY).hosts);
    const callTsMs = tsMs + dur * cursor;
    // the callee's transaction; its measured duration drives the exit span
    const exitId = t.hex(16);
    const calleeDur = makeTransaction(callee, calleeRoute, calleeHost, callTsMs + 1, version, errMult, traceId, exitId);
    const exitDur = calleeDur + 0.5 + t.rng() * 4; // + network overhead
    const tsUs = Math.round(callTsMs * 1000);
    emit(svc.name, host, tsUs, { span: {
      id: exitId, trace_id: traceId, transaction_id: txnId, parent_id: txnId,
      name: `${calleeRoute.name.split(' ')[0]} ${call.to}${calleeRoute.name.includes(' ') ? ' ' + calleeRoute.name.split(' ')[1] : ''}`,
      type: 'external', subtype: 'http',
      duration: Math.round(exitDur * 1000) / 1000, timestamp: tsUs,
      sync: false, outcome: 'success',
      context: { http: { method: calleeRoute.name.split(' ')[0], url: `http://${call.to}.internal${calleeRoute.name.split(' ')[1] ?? ''}`, status_code: 200 },
        destination: { address: `${call.to}.internal`, port: 8080, service: { resource: call.to } } },
    } });
    cursor += (exitDur / dur) + 0.02;
    started++;
  }

  const tsUs = Math.round(tsMs * 1000);
  emit(svc.name, host, tsUs, { transaction: {
    id: txnId, trace_id: traceId, ...(inbound && { parent_id: inbound }),
    name: route.name, type: 'request',
    duration: Math.round(dur * 1000) / 1000, timestamp: tsUs,
    result: `HTTP ${String(status)[0]}xx`, sampled: true,
    outcome: failed ? 'failure' : 'success',
    span_count: { started },
    context: {
      request: { method, http_version: '1.1',
        url: { protocol: 'https:', hostname: `${svc.name}.example.com`, pathname: path, full: `https://${svc.name}.example.com${path}` },
        headers: { 'user-agent': 'app/1.0', accept: 'application/json' },
        socket: { remote_address: `203.0.${t.int(0, 31)}.${t.int(1, 254)}` } },
      response: { status_code: status, finished: true, headers_sent: true },
      ...(userId && { user: { id: userId } }),
    },
  } });

  if (failed) {
    const shape = t.pick(ERROR_SHAPES);
    const frames = Array.from({ length: t.int(4, 8) }, () => {
      const [filename, fn] = t.pick(FRAME_FILES);
      return { filename, abs_path: `/srv/${svc.name}/${filename}`, function: fn,
        lineno: t.int(10, 400), library_frame: filename.startsWith('node_modules') };
    });
    const eTs = Math.round((tsMs + dur * 0.7) * 1000);
    emit(svc.name, host, eTs, { error: {
      id: t.hex(16), timestamp: eTs, trace_id: traceId, transaction_id: txnId, parent_id: txnId,
      culprit: `${frames[0].filename}:${frames[0].function}`,
      transaction: { name: route.name, type: 'request', sampled: true },
      exception: { message: shape.msg, type: shape.type, ...(shape.code && { code: shape.code }), handled: false, stacktrace: frames },
      ...(userId && { context: { user: { id: userId } } }),
    } });
  }
  return dur;
}

function makeScannerHit(host, tsMs) {
  const tsUs = Math.round(tsMs * 1000);
  const path = t.pick(SCANNER_PATHS);
  emit('unknown-route', host, tsUs, { transaction: {
    id: t.hex(16), trace_id: t.hex(32), name: `${t.pick(['GET', 'POST', 'HEAD'])} unknown route`, type: 'request',
    duration: Math.round((0.4 + t.rng() * 4) * 1000) / 1000, timestamp: tsUs,
    result: `HTTP ${t.pick(['4', '4', '4', '3'])}xx`, sampled: true, outcome: 'failure',
    span_count: { started: 0 },
    context: {
      request: { method: t.pick(['GET', 'POST', 'HEAD']), http_version: '1.1',
        url: { protocol: 'https:', hostname: 'public-api.example.com', pathname: path, full: `https://public-api.example.com${path}` },
        headers: { 'user-agent': t.pick(SCANNER_AGENTS), accept: '*/*' },
        socket: { remote_address: `${t.int(45, 220)}.${t.int(0, 255)}.${t.int(0, 255)}.${t.int(1, 254)}` } },
      response: { status_code: t.pick([404, 404, 403, 400]), finished: true, headers_sent: true },
    },
  } });
}

// A client lifetime: identity carried by its RecordOrigin (device / os / app
// version / opaque device id) and joined to records by lifetime_id.
function spawnLifetime(version) {
  const dev = t.pick(DEVICES);
  const loc = t.pick(LOCALE_TZ);
  return {
    id: t.hex(16),
    deviceId: t.hex(16), // opaque install id → origin.device.id
    dev, locale: loc.locale, tz: loc.tz, version,
    user: t.pick(USERS),
    yearClass: t.pick([2019, 2020, 2021, 2022, 2023]),
  };
}

// The once-per-lifetime RecordOrigin, as an in-stream `metadata` record keyed by
// lifetime_id (the new schema: service + runtime + os + device, device.id is the
// opaque install id). Emitted before the lifetime's first record in this file.
function ensureOrigin(host, tsMs, lt) {
  if (emittedOrigins.has(lt.id)) return;
  emittedOrigins.add(lt.id);
  emit('client', host, Math.round(tsMs * 1000) - 1, { metadata: {
    lifetime_id: lt.id,
    service: { name: 'duiduidui-app', version: lt.version },
    runtime: { name: 'react-native', version: '0.79.2' },
    os: { name: lt.dev.os, version: lt.dev.osv },
    device: { id: lt.deviceId, model: lt.dev.model, brand: lt.dev.brand,
      type: lt.dev.model.includes('iPad') ? 'tablet' : 'phone', year_class: lt.yearClass },
  } });
}

function makeClientEvent(host, tsMs, lt) {
  const ev = t.weighted(EVENT_TYPES, EVENT_W);
  const r = t.rng();
  const level = ev.type === 'log' ? (r < 0.8 ? 'info' : r < 0.95 ? 'warn' : 'error') : (r < 0.95 ? 'info' : 'warn');
  const tsUs = Math.round(tsMs * 1000);
  ensureOrigin(host, tsMs, lt);
  emit('client', host, tsUs, { event: {
    // Events are untimed (no duration) and don't inline client identity — it
    // rides on the RecordOrigin (joined via lifetime_id). locale is per-event;
    // labels is the attribute bag (was `params`); user is in context.
    type: ev.type, timestamp: tsUs, level, tz_offset: lt.tz, locale: lt.locale,
    lifetime_id: lt.id,
    ...(ev.type === 'log' ? { message: t.pick(['cache warmed', 'queue drained', 'retrying request', 'slow frame observed', 'config reloaded']) } : {}),
    ...(t.rng() < 0.05 && level !== 'info' ? { error: { message: 'request retried after upstream timeout', type: 'RetryableError' } } : {}),
    context: {
      user: { id: lt.user },
      labels: { screen: t.pick(['home', 'search', 'content', 'checkout', 'account', 'settings']),
        ...(ev.type === 'purchase' && { items: t.int(1, 8), total: Math.round(t.rng() * 24000 + 500) / 100 }),
        ...(ev.type === 'feature_used' && { feature: t.pick(['bulk-edit', 'saved-search', 'dark-mode', 'export', 'api-token']) }) },
    },
  } });
}

// A client trace: a root transaction (type 'app') with child spans — the SDK's
// startTransaction/startSpan. Carries the lifetime_id so the viewer resolves its
// origin.
function makeClientPerf(host, tsMs, lt) {
  const flow = t.pick(PERF_FLOWS);
  const traceId = t.hex(32);
  const rootId = t.hex(16);
  const total = Math.max(50, Math.exp(Math.log(flow.med) + flow.sig * t.normal()));
  const tsUs = Math.round(tsMs * 1000);
  ensureOrigin(host, tsMs, lt);
  emit('client', host, tsUs, { transaction: {
    id: rootId, trace_id: traceId, name: flow.root, type: 'app',
    duration: Math.round(total * 1000) / 1000, timestamp: tsUs,
    result: 'success', outcome: 'success', sampled: true, span_count: { started: flow.children.length },
    tz_offset: lt.tz, lifetime_id: lt.id, context: { user: { id: lt.user } },
  } });
  let cursor = 0.02;
  for (const child of flow.children) {
    const frac = (0.95 - cursor) * (0.3 + t.rng() * 0.5);
    const cTs = Math.round((tsMs + total * cursor) * 1000);
    emit('client', host, cTs, { span: {
      id: t.hex(16), trace_id: traceId, transaction_id: rootId, parent_id: rootId, name: child, type: 'app',
      duration: Math.round(Math.max(1, total * frac) * 1000) / 1000, timestamp: cTs, sync: false, outcome: 'success',
      lifetime_id: lt.id,
    } });
    cursor += frac + 0.02;
  }
}

function pct(v) { return { value: Math.round(v * 1000) / 1000 }; }
function makeMetricsets(channel, host, tsMs, svc) {
  const tsUs = Math.round(tsMs * 1000);
  const heap = 180e6 + t.rng() * 120e6;
  const sysCpu = 0.05 + t.rng() * 0.4;
  const procCpu = sysCpu * (0.55 + t.rng() * 0.35);
  const procUser = procCpu * (0.65 + t.rng() * 0.2);
  emit(channel, host, tsUs, { metricset: { timestamp: tsUs, samples: {
    'system.cpu.total.norm.pct': pct(sysCpu),
    'system.memory.actual.free': { value: Math.round(2e9 + t.rng() * 1e9) },
    'system.memory.total': { value: 4143972352 },
    'system.process.cpu.total.norm.pct': pct(procCpu),
    'system.process.cpu.user.norm.pct': pct(procUser),
    'system.process.cpu.system.norm.pct': pct(procCpu - procUser),
    'system.process.memory.rss.bytes': { value: Math.round(heap * 1.35 + 70e6 + t.rng() * 30e6) },
    'nodejs.memory.heap.used.bytes': { value: Math.round(heap) },
    'nodejs.memory.heap.allocated.bytes': { value: Math.round(heap * 1.4) },
    'nodejs.eventloop.delay.avg.ms': { value: Math.round(t.rng() * 12 * 1000) / 1000 },
    'nodejs.handles.active': { value: t.int(8, 60) },
    'nodejs.requests.active': { value: t.int(0, 12) },
  } } });
  // a couple of span-self-time breakdown metricsets, attributed to a route+dep
  for (let i = 0; i < 2; i++) {
    const route = t.pick(svc.routes);
    const depKey = route.local.length ? t.pick(route.local) : 'app';
    const dep = SPAN_TYPES[depKey];
    emit(channel, host, tsUs, { metricset: { timestamp: tsUs,
      transaction: { name: route.name, type: 'request' },
      span: dep ? { type: dep.type, subtype: dep.subtype } : { type: 'app' },
      samples: { 'span.self_time.count': { value: t.int(1, 40) }, 'span.self_time.sum.us': { value: t.int(500, 800_000) } },
    } });
  }
}

// --------------------------------------------------------------- file output

function metadataLine(service, host, version) {
  return JSON.stringify({ metadata: {
    service: { name: service, version, environment: 'production', agent: { name: 'tracelog', version: '1.11.0' } },
    process: { pid: 1234, title: 'node', argv: ['/usr/bin/node', `/srv/${service}/server.js`] },
    system: { hostname: host, architecture: 'x64', platform: 'linux' },
  } });
}

const totals = {}; // channel → { records, files, raw, gz }
function bump(channel, key, n) { (totals[channel] ??= { records: 0, files: 0, raw: 0, gz: 0 })[key] += n; }

function writeDay(interval) {
  for (const [channel, perHost] of Object.entries(bucket)) {
    // a channel's "service" for metadata: a real service, or the channel name
    const serviceName = SERVICES[channel] ? channel : channel;
    for (const [host, recs] of Object.entries(perHost)) {
      recs.sort((a, b) => a.ts - b.ts);
      const version = (FLEET[channel] ? fleetOn(channel, CUR_DAY).version : '1.0.0');
      const dir = join(OUT, channel, interval);
      mkdirSync(dir, { recursive: true });
      // split into _seq files at MAX_FILE_BYTES uncompressed
      let buf = [metadataLine(serviceName, host, version)];
      let bytes = buf[0].length + 1;
      let seq = 0;
      const flush = () => {
        const name = seq === 0 ? `${host}.jsonl.gz` : `${host}_${seq}.jsonl.gz`;
        const raw = Buffer.from(buf.join('\n') + '\n');
        const gz = gzipSync(raw, { level: 6 });
        writeFileSync(join(dir, name), gz);
        const acc = new MetaAccumulator();
        acc.addChunk(raw.toString('utf8'));
        acc.flushPartial();
        writeFileSync(join(dir, sidecarKey(name)), JSON.stringify(acc.toMeta(interval, raw.length, gz.length)));
        bump(channel, 'files', 1); bump(channel, 'raw', raw.length); bump(channel, 'gz', gz.length);
        seq += 1;
        buf = [metadataLine(serviceName, host, version)];
        bytes = buf[0].length + 1;
      };
      for (const r of recs) {
        if (bytes + r.line.length > MAX_FILE_BYTES) flush();
        buf.push(r.line);
        bytes += r.line.length + 1;
      }
      flush();
      bump(channel, 'records', recs.length);
    }
  }
}

// ----------------------------------------------------------- helpers + driver

let CUR_DAY = 0; // the day index currently being generated (for fleet lookups)
function fleetOn(serviceName, dayIdx) { return FLEET[serviceName][dayIdx]; }

// per-day traffic weight (weekly × growth), and its sum for normalization
const dayWeights = [];
for (let d = 0; d < TOTAL_DAYS; d++) {
  const interval = intervalLabel(END_INTERVAL, TOTAL_DAYS - 1 - d);
  const ms = Date.parse(interval + 'T00:00:00Z');
  dayWeights.push(weeklyWeight(ms) * growthWeight(d));
}
const dayWeightSum = dayWeights.reduce((a, b) => a + b, 0);

const serverBudget = TARGET * SERVER_FRAC;
const clientBudget = TARGET * CLIENT_FRAC;
const metricsetBudget = TARGET * METRICSET_FRAC;

for (let d = 0; d < TOTAL_DAYS; d++) {
  CUR_DAY = d;
  bucket = {};
  const interval = intervalLabel(END_INTERVAL, TOTAL_DAYS - 1 - d);
  const dayStartMs = Date.parse(interval + 'T00:00:00Z');
  const share = dayWeights[d] / dayWeightSum;

  // --- server request traffic: generate entry transactions until the day's
  //     record budget is met (a tree fans out across services, so count grows
  //     faster than the root count). Distribute roots over the diurnal curve.
  const dayServerRecords = Math.round(serverBudget * share);
  const incidentToday = d === INCIDENT.dayIdx;
  let serverMade = 0;
  let guard = 0;
  while (serverMade < dayServerRecords && guard++ < dayServerRecords * 2 + 1000) {
    // pick an hour by the diurnal weight, then a time within it
    let hAcc = t.rng() * HOUR_W_SUM;
    let hour = 0;
    for (let h = 0; h < 24; h++) { if ((hAcc -= HOUR_W[h]) < 0) { hour = h; break; } }
    const tsMs = dayStartMs + hour * 3600_000 + t.rng() * 3600_000;
    // entry service (mostly public-api) + route
    const svc = SERVICES[t.weighted(SERVICE_NAMES.map((n) => ({ w: SERVICES[n].weight, n })), SERVICE_W).n];
    const route = t.weighted(svc.routes, svc.routeW);
    const host = t.pick(fleetOn(svc.name, d).hosts);
    let errMult = 1;
    if (incidentToday && svc.name === INCIDENT.service) {
      const offset = tsMs - (dayStartMs + INCIDENT.startMs);
      if (offset >= 0 && offset < INCIDENT.durMs) errMult = INCIDENT.mult;
    }
    const before = recordCount();
    makeTransaction(svc, route, host, tsMs, fleetOn(svc.name, d).version, errMult);
    // public-api also catches scanner noise → unknown-route
    if (svc.scanner && t.rng() < 0.04) makeScannerHit(t.pick(fleetOn('public-api', d).hosts), tsMs + t.rng() * 1000);
    serverMade += recordCount() - before;
  }

  // --- client telemetry: events + perf flows, on the public-api relay hosts.
  //     a slice of events is back-dated 1–2 days (a buffered offline client
  //     flushing late) so this file's sidecar shows interval drift.
  const dayClientRecords = Math.round(clientBudget * share);
  // Roll the lifetime pool: retire ~half of yesterday's launches, refill with new
  // ones. Carried-over lifetimes keep their origin in an earlier interval, so
  // their records today resolve via the backward hop, not the in-window map.
  const POOL_SIZE = 40;
  lifetimePool = lifetimePool.filter(() => t.rng() < 0.5);
  while (lifetimePool.length < POOL_SIZE) lifetimePool.push(spawnLifetime(fleetOn('public-api', d).version));
  let clientMade = 0;
  while (clientMade < dayClientRecords) {
    let hAcc = t.rng() * HOUR_W_SUM; let hour = 0;
    for (let h = 0; h < 24; h++) { if ((hAcc -= HOUR_W[h]) < 0) { hour = h; break; } }
    let tsMs = dayStartMs + hour * 3600_000 + t.rng() * 3600_000;
    if (t.rng() < 0.04) tsMs -= t.int(1, 2) * 86400_000; // buffered late flush
    const host = t.pick(fleetOn('public-api', d).hosts);
    const lt = t.pick(lifetimePool);
    const before = recordCount();
    if (t.rng() < 0.25) makeClientPerf(host, tsMs, lt);
    else makeClientEvent(host, tsMs, lt);
    clientMade += recordCount() - before;
  }

  // --- host metricsets: spread the day's budget across every active host of
  //     every service at an even cadence (host monitoring)
  const dayMetricsetRecords = Math.round(metricsetBudget * share);
  const activeHosts = [];
  for (const name of SERVICE_NAMES) for (const h of fleetOn(name, d).hosts) activeHosts.push({ channel: name, host: h, svc: SERVICES[name] });
  const emissionsPerHost = Math.max(1, Math.round(dayMetricsetRecords / 3 / Math.max(1, activeHosts.length)));
  for (const { channel, host, svc } of activeHosts) {
    for (let i = 0; i < emissionsPerHost; i++) {
      const tsMs = dayStartMs + (i + t.rng()) * (86400_000 / emissionsPerHost);
      makeMetricsets(channel, host, tsMs, svc);
    }
  }

  writeDay(interval);
  process.stdout.write(`\r  ${interval}: generated…   `);
}

function recordCount() {
  let n = 0;
  for (const perHost of Object.values(bucket)) for (const recs of Object.values(perHost)) n += recs.length;
  return n;
}

// ------------------------------------------------------------------- summary

console.log('\n');
let grand = { records: 0, files: 0, raw: 0, gz: 0 };
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
for (const ch of Object.keys(totals).sort()) {
  const x = totals[ch];
  console.log(`${ch.padEnd(20)} ${x.records.toLocaleString().padStart(12)} records · ${String(x.files).padStart(4)} files · ${mb(x.raw)} → ${mb(x.gz)} gz`);
  for (const k of Object.keys(grand)) grand[k] += x[k];
}
console.log(`${'TOTAL'.padEnd(20)} ${grand.records.toLocaleString().padStart(12)} records · ${String(grand.files).padStart(4)} files · ${mb(grand.raw)} → ${mb(grand.gz)} gz`);
console.log(`\nincident: ${INCIDENT.service} on ${intervalLabel(END_INTERVAL, TOTAL_DAYS - 1 - INCIDENT.dayIdx)} (${INCIDENT.mult}× error rate, ~30 min)`);
