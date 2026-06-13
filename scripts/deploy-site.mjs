#!/usr/bin/env node
/**
 * Deploy the viewer to its static host (SPEC §10: one distribution serving
 * identical bytes to every workspace subdomain). Zero dependencies; shells
 * out to the aws CLI so credentials/profiles work exactly like the rest of
 * your tooling.
 *
 *   AWS_PROFILE=redthread node scripts/deploy-site.mjs \
 *     [--bucket tracelog-org-site] [--distribution E3B4UTXPAPQSMG]
 *
 * Flags fall back to BUCKET / DISTRIBUTION_ID env vars, then defaults.
 * Self-hosters: point --bucket/--distribution at your own infrastructure —
 * or skip this entirely; `vite build` emits relative-pathed static files
 * that work from any host.
 */
import { spawnSync } from 'node:child_process';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) =>
    a.startsWith('--') ? [a.slice(2), all[i + 1]] : null,
  ).filter(Boolean),
);
const BUCKET = args.bucket ?? process.env.BUCKET ?? 'tracelog-org-site';
const DISTRIBUTION = args.distribution ?? process.env.DISTRIBUTION_ID ?? 'E3B4UTXPAPQSMG';

function run(cmd, argv) {
  console.log(`\n› ${cmd} ${argv.join(' ')}`);
  const res = spawnSync(cmd, argv, { stdio: 'inherit' });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

run('npx', ['vite', 'build']);

// hashed assets are immutable: cache forever
run('aws', ['s3', 'sync', 'dist/assets', `s3://${BUCKET}/assets`,
  '--cache-control', 'public,max-age=31536000,immutable', '--delete']);

// the entry point names the current hashes: keep it fresh
run('aws', ['s3', 'cp', 'dist/index.html', `s3://${BUCKET}/index.html`,
  '--cache-control', 'public,max-age=60',
  '--content-type', 'text/html; charset=utf-8']);

run('aws', ['cloudfront', 'create-invalidation', '--distribution-id', DISTRIBUTION,
  '--paths', '/index.html', '--query', 'Invalidation.Id', '--output', 'text']);

console.log(`\ndeployed to s3://${BUCKET}`);
