#!/usr/bin/env node
/**
 * Synthetic fleet generator (SPEC §8.1) — writes gzipped tracelog JSONL in
 * the exact §3.1 key layout so the viewer can be stress-tested at known
 * record counts. The record shapes follow tracelog's SCHEMA.md: timestamps
 * in epoch µs, durations in ms, one top-level kind key per line.
 *
 * Zero dependencies; deterministic for a given seed.
 *
 *   node scripts/synth-fleet.mjs --out /tmp/tracelog-fleet [--seed 20260612]
 *       [--tiers tier-10k,tier-100k,tier-1m] [--end 2026-06-11]
 *
 * Each tier is its own channel, so tiers are selected in the viewer the
 * same way real channels are. All days are in the past → every file is
 * finalized (no `_current`), which also exercises the IndexedDB cache.
 *
 * Upload (content headers must match what tracelog itself sets):
 *   AWS_PROFILE=... aws s3 sync /tmp/tracelog-fleet s3://tracelog-test \
 *     --content-encoding gzip --content-type application/x-ndjson
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

// ---------------------------------------------------------------- CLI args

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) =>
    a.startsWith('--') ? [a.slice(2), all[i + 1]] : null,
  ).filter(Boolean),
);
const OUT = args.out;
if (!OUT) {
  console.error('usage: node scripts/synth-fleet.mjs --out DIR [--seed N] [--tiers a,b] [--end YYYY-MM-DD]');
  process.exit(1);
}
const SEED = Number(args.seed ?? 20260612);
const END_DAY = args.end ?? '2026-06-11'; // last (most recent) generated day

// ------------------------------------------------------------------- tiers

const TIERS = [
  { channel: 'tier-10k', target: 10_000, days: 1, hosts: 1 },
  { channel: 'tier-100k', target: 100_000, days: 3, hosts: 1 },
  { channel: 'tier-1m', target: 1_000_000, days: 7, hosts: 4 },
].filter((t) => !args.tiers || args.tiers.split(',').includes(t.channel));

// Force `_seq` overflow files at the high end (SPEC §8.1 realism note).
const MAX_FILE_BYTES = 12 * 1024 * 1024; // uncompressed, per file

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
const makeTools = (rng) => ({
  rng,
  hex: (n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += HEX[(rng() * 16) | 0];
    return s;
  },
  // Box–Muller standard normal
  normal: () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng()),
  pick: (arr) => arr[(rng() * arr.length) | 0],
  int: (lo, hi) => lo + ((rng() * (hi - lo + 1)) | 0),
});

// ------------------------------------------------------------ fleet realism

// Route pool: weight, median ms, log-normal sigma, span profile, error rate.
const ROUTES = [
  { name: 'GET /healthz',            w: 18, med: 2,   sig: 0.3, spans: [],                          err: 0.0001, user: 0 },
  { name: 'GET /api/decks',          w: 10, med: 28,  sig: 0.6, spans: ['mongo', 'redis'],          err: 0.002, user: 0.9 },
  { name: 'GET /api/decks/:id',      w: 12, med: 35,  sig: 0.7, spans: ['mongo', 'mongo', 'redis'], err: 0.002, user: 0.9 },
  { name: 'GET /api/cards/:id',      w: 14, med: 22,  sig: 0.6, spans: ['mongo', 'redis'],          err: 0.001, user: 0.9 },
  { name: 'POST /api/study-session', w: 8,  med: 90,  sig: 0.8, spans: ['mongo', 'mongo', 'redis'], err: 0.004, user: 1 },
  { name: 'POST /api/reviews',       w: 9,  med: 60,  sig: 0.7, spans: ['mongo', 'mongo'],          err: 0.003, user: 1 },
  { name: 'GET /api/search',         w: 6,  med: 140, sig: 0.9, spans: ['mongo', 'mongo', 'redis'], err: 0.005, user: 0.8 },
  { name: 'GET /api/audio/:id',      w: 7,  med: 75,  sig: 0.8, spans: ['redis', 's3'],             err: 0.003, user: 0.7 },
  { name: 'POST /api/tts',           w: 4,  med: 420, sig: 0.9, spans: ['redis', 'http', 's3'],     err: 0.008, user: 1 },
  { name: 'POST /api/sync',          w: 6,  med: 180, sig: 0.9, spans: ['mongo', 'mongo', 'mongo'], err: 0.004, user: 1 },
  { name: 'POST /logs',              w: 8,  med: 12,  sig: 0.5, spans: [],                          err: 0.0005, user: 0.6 },
  { name: 'GET /api/profile',        w: 5,  med: 30,  sig: 0.6, spans: ['mongo'],                   err: 0.001, user: 1 },
  { name: 'POST /api/auth/login',    w: 3,  med: 110, sig: 0.7, spans: ['mongo', 'http'],           err: 0.01, user: 0.5 },
  { name: 'GET /api/stats',          w: 4,  med: 200, sig: 0.8, spans: ['mongo', 'mongo'],          err: 0.002, user: 1 },
];
const ROUTE_W = ROUTES.reduce((s, r) => s + r.w, 0);

const SPAN_KINDS = {
  mongo: { type: 'db', subtype: 'mongodb', action: 'query',
    names: ['cards.find', 'decks.findOne', 'reviews.insertOne', 'sessions.updateOne', 'users.findOne', 'stats.aggregate'],
    dest: { address: 'cluster0.mongodb.net', port: 27017 } },
  redis: { type: 'db', subtype: 'redis', action: 'exec',
    names: ['GET', 'SET', 'EXPIRE', 'MGET'],
    dest: { address: 'cache.internal', port: 6379 } },
  http: { type: 'external', subtype: 'http', action: undefined,
    names: ['POST api.openai.com', 'GET api.exchangerate.host', 'POST hooks.slack.com'],
    dest: { address: 'api.openai.com', port: 443 } },
  s3: { type: 'storage', subtype: 's3', action: undefined,
    names: ['S3 GetObject fleet-prod-speech', 'S3 PutObject fleet-prod-speech'],
    dest: { address: 's3.amazonaws.com', port: 443 } },
};

const EVENT_TYPES = [
  { type: 'page_view', w: 8 }, { type: 'lesson_complete', w: 3 },
  { type: 'audio_play', w: 6 }, { type: 'app_open', w: 3 },
  { type: 'sync_complete', w: 2 }, { type: 'log', w: 5 },
];
const EVENT_W = EVENT_TYPES.reduce((s, e) => s + e.w, 0);
const DEVICES = [
  { model: 'iPhone 15 Pro', brand: 'Apple', os: 'iOS', osv: '18.5' },
  { model: 'iPhone 13', brand: 'Apple', os: 'iOS', osv: '17.6' },
  { model: 'Pixel 9', brand: 'Google', os: 'Android', osv: '15' },
  { model: 'SM-S938B', brand: 'Samsung', os: 'Android', osv: '15' },
  { model: 'iPad Air', brand: 'Apple', os: 'iOS', osv: '18.5' },
];
const ERROR_SHAPES = [
  { type: 'MongoServerSelectionError', msg: 'connection timed out after 30000 ms', code: undefined },
  { type: 'TypeError', msg: "Cannot read properties of undefined (reading 'deckId')", code: undefined },
  { type: 'Error', msg: 'socket hang up', code: 'ECONNRESET' },
  { type: 'RangeError', msg: 'Maximum call stack size exceeded', code: undefined },
  { type: 'Error', msg: 'connect ETIMEDOUT 34.117.59.81:443', code: 'ETIMEDOUT' },
];
const FRAME_FILES = [
  ['lib/routes/decks.js', 'getDeck'], ['lib/routes/reviews.js', 'postReview'],
  ['lib/db/mongo.js', 'withCollection'], ['lib/services/tts.js', 'synthesize'],
  ['node_modules/mongodb/lib/sdam/topology.js', 'selectServer'],
  ['node_modules/express/lib/router/index.js', 'handle'],
];

// Diurnal traffic curve, peak ~14:00 UTC.
const HOUR_W = Array.from({ length: 24 }, (_, h) =>
  0.35 + 0.65 * (1 + Math.cos(((h - 14) / 24) * 2 * Math.PI)) / 2);
const HOUR_W_SUM = HOUR_W.reduce((a, b) => a + b, 0);

// --------------------------------------------------------------- generation

function dayString(endDay, back) {
  const [y, m, d] = endDay.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) - back * 86400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function metadataLine(host, version) {
  return JSON.stringify({ metadata: {
    service: {
      name: 'fleet-api', version, environment: 'production',
      agent: { name: 'tracelog', version: '1.9.0' },
    },
    process: { pid: 1234, title: 'node', argv: ['/usr/bin/node', '/srv/fleet/server.js'] },
    system: { hostname: host, architecture: 'x64', platform: 'linux' },
  } });
}

function makeRequest(t, tsMs, route, version, users, errMult = 1) {
  const recs = [];
  const traceId = t.hex(32);
  const txnId = t.hex(16);
  const dur = Math.min(30_000, Math.max(0.4,
    Math.exp(Math.log(route.med) + route.sig * t.normal())));
  const failed = t.rng() < route.err * errMult;
  const clientErr = !failed && t.rng() < 0.03;
  const status = failed ? 500 : clientErr ? t.pick([400, 404, 404]) : 200;
  const userId = t.rng() < route.user ? t.pick(users) : null;

  // spans: route profile, occasionally dropping or repeating one
  const profile = route.spans.filter(() => t.rng() < 0.92);
  if (route.spans.length && t.rng() < 0.15) profile.push(t.pick(route.spans));
  let cursor = 0.05 + t.rng() * 0.1; // fraction of txn elapsed
  for (const kindKey of profile) {
    const kind = SPAN_KINDS[kindKey];
    const frac = (0.85 - cursor) * (0.2 + t.rng() * 0.5);
    const sDur = Math.max(0.2, dur * frac);
    const sTs = Math.round((tsMs + dur * cursor) * 1000);
    cursor += frac + 0.02;
    const name = t.pick(kind.names);
    recs.push({ ts: sTs, line: JSON.stringify({ span: {
      id: t.hex(16), trace_id: traceId, transaction_id: txnId, parent_id: txnId,
      name, type: kind.type, ...(kind.subtype && { subtype: kind.subtype }),
      ...(kind.action && { action: kind.action }),
      duration: Math.round(sDur * 1000) / 1000, timestamp: sTs,
      sync: false, outcome: 'success',
      context: {
        ...(kind.type === 'db' && { db: { type: kind.subtype, instance: 'fleet' } }),
        ...(kind.subtype === 'http' && { http: { method: name.split(' ')[0], url: `https://${name.split(' ')[1]}/v1`, status_code: 200 } }),
        destination: { address: kind.dest.address, port: kind.dest.port,
          service: { resource: `${kind.subtype}/${kind.dest.address}` } },
      },
    } }) });
  }

  const tsUs = Math.round(tsMs * 1000);
  const [method, path] = route.name.split(' ');
  recs.push({ ts: tsUs, line: JSON.stringify({ transaction: {
    id: txnId, trace_id: traceId, name: route.name, type: 'request',
    duration: Math.round(dur * 1000) / 1000, timestamp: tsUs,
    result: `HTTP ${String(status)[0]}xx`, sampled: true,
    outcome: failed ? 'failure' : 'success',
    span_count: { started: profile.length },
    context: {
      request: {
        method, http_version: '1.1',
        url: { protocol: 'https:', hostname: 'api.fleet.example', pathname: path, full: `https://api.fleet.example${path}` },
        headers: { 'user-agent': 'fleet-app/1.0', accept: 'application/json' },
        socket: { remote_address: `203.0.${t.int(0, 31)}.${t.int(1, 254)}` },
      },
      response: { status_code: status, finished: true, headers_sent: true },
      ...(userId && { user: { id: userId } }),
    },
  } }) });

  if (failed) {
    const shape = t.pick(ERROR_SHAPES);
    const frames = Array.from({ length: t.int(4, 8) }, () => {
      const [filename, fn] = t.pick(FRAME_FILES);
      return { filename, abs_path: `/srv/fleet/${filename}`, function: fn,
        lineno: t.int(10, 400), library_frame: filename.startsWith('node_modules') };
    });
    const eTs = Math.round((tsMs + dur * 0.7) * 1000);
    recs.push({ ts: eTs, line: JSON.stringify({ error: {
      id: t.hex(16), timestamp: eTs, trace_id: traceId,
      transaction_id: txnId, parent_id: txnId,
      culprit: `${frames[0].filename}:${frames[0].function}`,
      transaction: { name: route.name, type: 'request', sampled: true },
      exception: { message: shape.msg, type: shape.type,
        ...(shape.code && { code: shape.code }), handled: false, stacktrace: frames },
      ...(userId && { context: { user: { id: userId } } }),
    } }) });
  }
  return recs;
}

function makeEvent(t, tsMs, version, users) {
  let acc = t.rng() * EVENT_W;
  const ev = EVENT_TYPES.find((e) => (acc -= e.w) < 0) ?? EVENT_TYPES[0];
  const r = t.rng();
  const level = ev.type === 'log' ? (r < 0.8 ? 'info' : r < 0.95 ? 'warn' : 'error')
    : (r < 0.94 ? 'info' : 'warn');
  const tsUs = Math.round(tsMs * 1000);
  const dev = t.pick(DEVICES);
  return { ts: tsUs, line: JSON.stringify({ event: {
    type: ev.type, timestamp: tsUs, level,
    ...(ev.type === 'log'
      ? { message: t.pick(['cache warmed', 'queue drained', 'retrying mongo connect', 'slow request observed', 'config reloaded']) }
      : {}),
    ...(t.rng() < 0.05 && level !== 'info'
      ? { error: { message: 'sync conflict: deck modified on two devices', type: 'SyncConflict' } }
      : {}),
    ...(ev.type !== 'log' && { duration: Math.round(t.rng() * 4000) / 1000 }),
    user: { id: t.pick(users) },
    ...(t.rng() < 0.6 && { client: {
      name: 'fleet-app', version,
      os: { name: dev.os, version: dev.osv },
      device: { model: dev.model, brand: dev.brand, type: dev.model.includes('iPad') ? 'tablet' : 'phone' },
      locale: t.pick(['en-US', 'zh-Hans-CN', 'es-MX', 'de-DE']),
    } }),
    params: { screen: t.pick(['home', 'deck', 'review', 'stats', 'settings']),
      ...(ev.type === 'lesson_complete' && { cards: t.int(5, 40), accuracy: Math.round(t.rng() * 40 + 60) / 100 }) },
  } }) };
}

function makeMetricsets(t, tsMs, topRoutes) {
  const tsUs = Math.round(tsMs * 1000);
  const heap = 180e6 + t.rng() * 120e6;
  const out = [{ ts: tsUs, line: JSON.stringify({ metricset: {
    timestamp: tsUs,
    samples: {
      'system.cpu.total.norm.pct': { value: Math.round((0.05 + t.rng() * 0.4) * 1000) / 1000 },
      'system.memory.actual.free': { value: Math.round(2e9 + t.rng() * 1e9) },
      'system.memory.total': { value: 4143972352 },
      'nodejs.memory.heap.used.bytes': { value: Math.round(heap) },
      'nodejs.memory.heap.allocated.bytes': { value: Math.round(heap * 1.4) },
      'nodejs.eventloop.delay.avg.ms': { value: Math.round(t.rng() * 12 * 1000) / 1000 },
      'nodejs.handles.active': { value: t.int(8, 60) },
      'nodejs.requests.active': { value: t.int(0, 12) },
    },
  } }) }];
  for (let i = 0; i < 2; i++) {
    const route = t.pick(topRoutes);
    const kindKey = route.spans.length ? t.pick(route.spans) : 'app';
    const kind = SPAN_KINDS[kindKey];
    out.push({ ts: tsUs, line: JSON.stringify({ metricset: {
      timestamp: tsUs,
      transaction: { name: route.name, type: 'request' },
      span: kind ? { type: kind.type, subtype: kind.subtype } : { type: 'app' },
      samples: {
        'span.self_time.count': { value: t.int(1, 40) },
        'span.self_time.sum.us': { value: t.int(500, 800_000) },
      },
    } }) });
  }
  return out;
}

// ------------------------------------------------------------- file writing

function writeHostDay(dir, host, lines) {
  // split into _seq files at MAX_FILE_BYTES uncompressed (§3.1 grammar)
  const files = [];
  let buf = [];
  let bytes = 0;
  let seq = 0;
  const flush = () => {
    if (!buf.length) return;
    const name = seq === 0 ? `${host}.jsonl.gz` : `${host}_${seq}.jsonl.gz`;
    const raw = Buffer.from(buf.join('\n') + '\n');
    const gz = gzipSync(raw, { level: 6 });
    writeFileSync(join(dir, name), gz);
    files.push({ name, raw: raw.length, gz: gz.length, lines: buf.length });
    seq += 1;
    buf = [];
    bytes = 0;
  };
  for (const line of lines) {
    if (bytes + line.length > MAX_FILE_BYTES) flush();
    buf.push(line);
    bytes += line.length + 1;
  }
  flush();
  return files;
}

// --------------------------------------------------------------------- main

const grand = { records: 0, raw: 0, gz: 0, files: 0 };
for (const tier of TIERS) {
  const t = makeTools(mulberry32(SEED ^ hashStr(tier.channel)));
  const users = Array.from({ length: 200 }, (_, i) => `user-${String(i + 1).padStart(4, '0')}`);
  const topRoutes = ROUTES.filter((r) => r.spans.length);
  const perHostDay = Math.round(tier.target / (tier.days * tier.hosts));
  const hosts = Array.from({ length: tier.hosts }, (_, i) => `10.0.${1 + ((i / 250) | 0)}.${10 + (i % 250)}`);
  const kindCounts = {};
  const tierTotals = { records: 0, raw: 0, gz: 0, files: 0 };

  for (let back = tier.days - 1; back >= 0; back--) {
    const day = dayString(END_DAY, back);
    const dayStartMs = Date.parse(day + 'T00:00:00Z');
    // deployment marker: version bump halfway through the range
    const version = back >= tier.days / 2 ? '2.3.0' : '2.4.0';

    for (const host of hosts) {
      const recs = [];
      // metricsets at a cadence that spends ≤40% of the host-day budget
      const msBudget = Math.min(3 * 1440, Math.floor(perHostDay * 0.4));
      const msTriples = Math.max(1, Math.floor(msBudget / 3));
      const msCadenceMs = 86400_000 / msTriples;
      for (let i = 0; i < msTriples; i++) {
        recs.push(...makeMetricsets(t, dayStartMs + i * msCadenceMs + t.rng() * 800, topRoutes));
      }
      // traffic fills the rest: ~15% of records are standalone events, the
      // rest request units (txn + spans + occasional error). A request unit
      // emits ~2.4 records, so the per-iteration event probability is higher
      // than the record share.
      const traffic = perHostDay - msTriples * 3;
      // error burst (SPEC §8.1): one ~10-minute window per host-day at 25×
      const burstStart = dayStartMs + t.rng() * 85_800_000;
      const burstEnd = burstStart + 600_000;
      let made = 0;
      for (let h = 0; h < 24 && made < traffic; h++) {
        const hourShare = Math.round((traffic * HOUR_W[h]) / HOUR_W_SUM);
        const hourStart = dayStartMs + h * 3600_000;
        let inHour = 0;
        while (inHour < hourShare && made < traffic) {
          const tsMs = hourStart + t.rng() * 3600_000;
          if (t.rng() < 0.33) {
            recs.push(makeEvent(t, tsMs, version, users));
            inHour += 1; made += 1;
          } else {
            let acc = t.rng() * ROUTE_W;
            const route = ROUTES.find((r) => (acc -= r.w) < 0) ?? ROUTES[0];
            const errMult = tsMs >= burstStart && tsMs < burstEnd ? 25 : 1;
            const unit = makeRequest(t, tsMs, route, version, users, errMult);
            recs.push(...unit);
            inHour += unit.length; made += unit.length;
          }
        }
      }
      recs.sort((a, b) => a.ts - b.ts);
      const lines = [metadataLine(host, version), ...recs.map((r) => r.line)];
      for (const r of recs) {
        const kind = r.line.slice(2, r.line.indexOf('"', 2));
        kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
      }
      const dir = join(OUT, tier.channel, day);
      mkdirSync(dir, { recursive: true });
      for (const f of writeHostDay(dir, host, lines)) {
        tierTotals.files += 1;
        tierTotals.raw += f.raw;
        tierTotals.gz += f.gz;
      }
      tierTotals.records += recs.length;
    }
  }

  grand.records += tierTotals.records;
  grand.raw += tierTotals.raw;
  grand.gz += tierTotals.gz;
  grand.files += tierTotals.files;
  const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
  console.log(`\n${tier.channel}: ${tierTotals.records.toLocaleString()} records, ` +
    `${tierTotals.files} files, ${mb(tierTotals.raw)} raw → ${mb(tierTotals.gz)} gz`);
  for (const [k, v] of Object.entries(kindCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(12)} ${v.toLocaleString().padStart(10)}`);
  }
}

console.log(`\nTOTAL: ${grand.records.toLocaleString()} records, ${grand.files} files, ` +
  `${(grand.raw / 1024 / 1024).toFixed(1)} MB raw → ${(grand.gz / 1024 / 1024).toFixed(1)} MB gz`);
