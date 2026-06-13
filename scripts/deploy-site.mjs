#!/usr/bin/env node
/**
 * Turnkey static hosting for the viewer (SPEC §10): builds, provisions,
 * and deploys to your AWS account — creating whatever doesn't exist and
 * adopting whatever does, so it is safe to run repeatedly. Zero npm
 * dependencies; shells out to the aws CLI, so profiles/SSO work as usual.
 *
 *   AWS_PROFILE=me node scripts/deploy-site.mjs \
 *     --bucket my-viewer-site --domain viewer.example.org
 *
 * Steps (each skippable):
 *   bucket    create (private, public-access-blocked) or adopt
 *   distro    adopt --distribution ID, or find by --domain alias, or
 *             create: OAC + CloudFront (apex + wildcard aliases, ACM cert
 *             auto-discovered in us-east-1 unless --cert given)
 *   dns       UPSERT alias A/AAAA for the domain (+ wildcard) when the
 *             Route53 zone exists in this account
 *   deploy    vite build → upload (immutable assets, fresh index.html) →
 *             invalidation
 *
 * Flags: --bucket NAME  --domain HOST  --cert ARN  --distribution ID
 *        --no-wildcard  --skip-infra  --skip-dns  --skip-build
 *        --skip-upload
 * Without --domain, infra stops at the bucket and you front it yourself.
 */
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : (argv[i + 1] ?? null);
};
const has = (name) => argv.includes(`--${name}`);

const BUCKET = flag('bucket') ?? process.env.BUCKET ?? null;
const DOMAIN = flag('domain') ?? null;
const WILDCARD = !has('no-wildcard');
let DISTRIBUTION = flag('distribution') ?? process.env.DISTRIBUTION_ID ?? null;
let CERT = flag('cert') ?? null;
if (!BUCKET) {
  console.error('--bucket is required (the S3 bucket that holds the site)');
  process.exit(1);
}

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { code: res.status ?? 1, out: (res.stdout ?? '').trim(), err: (res.stderr ?? '').trim() };
}
function aws(args, { json = true, allowFail = false } = {}) {
  const res = sh('aws', args);
  if (res.code !== 0) {
    if (allowFail) return null;
    console.error(`aws ${args.slice(0, 3).join(' ')} failed:\n${res.err}`);
    process.exit(1);
  }
  return json && res.out ? JSON.parse(res.out) : res.out;
}
const step = (msg) => console.log(`\n— ${msg}`);

// ---------------------------------------------------------------- bucket
if (!has('skip-infra')) {
  step(`bucket s3://${BUCKET}`);
  if (sh('aws', ['s3api', 'head-bucket', '--bucket', BUCKET]).code === 0) {
    console.log('  exists — adopted');
  } else {
    aws(['s3api', 'create-bucket', '--bucket', BUCKET], { json: false });
    aws(['s3api', 'put-public-access-block', '--bucket', BUCKET,
      '--public-access-block-configuration',
      'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'], { json: false });
    console.log('  created (private; CloudFront reads via OAC)');
  }
}

// ---------------------------------------------------- distribution (+ OAC)
if (!has('skip-infra') && !DISTRIBUTION && DOMAIN) {
  step(`distribution for ${DOMAIN}`);
  const region = aws(['s3api', 'get-bucket-location', '--bucket', BUCKET]).LocationConstraint ?? 'us-east-1';
  const originDomain = `${BUCKET}.s3.${region}.amazonaws.com`;
  const list = aws(['cloudfront', 'list-distributions'])?.DistributionList?.Items ?? [];
  const hit = list.find((d) => (d.Aliases?.Items ?? []).includes(DOMAIN));
  if (hit) {
    DISTRIBUTION = hit.Id;
    console.log(`  ${DISTRIBUTION} already serves ${DOMAIN} — adopted`);
  } else {
    if (!CERT) {
      const certs = aws(['acm', 'list-certificates', '--region', 'us-east-1',
        '--certificate-statuses', 'ISSUED'])?.CertificateSummaryList ?? [];
      const apex = DOMAIN.split('.').slice(-2).join('.');
      CERT = certs.find((c) => c.DomainName === DOMAIN || c.DomainName === apex)?.CertificateArn;
      if (!CERT) {
        console.error(`  no ISSUED us-east-1 ACM cert found for ${DOMAIN} — pass --cert ARN`);
        process.exit(1);
      }
      console.log(`  cert: ${CERT}`);
    }
    const oac = aws(['cloudfront', 'create-origin-access-control', '--origin-access-control-config',
      `Name=${BUCKET}-oac,Description=site bucket access,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3`,
    ]).OriginAccessControl.Id;
    const aliases = WILDCARD ? [DOMAIN, `*.${DOMAIN}`] : [DOMAIN];
    const config = {
      CallerReference: `${BUCKET}-${Date.now()}`,
      Comment: `${DOMAIN} viewer (tracelog)`,
      Enabled: true,
      DefaultRootObject: 'index.html',
      PriceClass: 'PriceClass_100',
      HttpVersion: 'http2and3',
      IsIPV6Enabled: true,
      Aliases: { Quantity: aliases.length, Items: aliases },
      ViewerCertificate: { ACMCertificateArn: CERT, SSLSupportMethod: 'sni-only', MinimumProtocolVersion: 'TLSv1.2_2021' },
      Origins: { Quantity: 1, Items: [{ Id: 'site', DomainName: originDomain, OriginAccessControlId: oac, S3OriginConfig: { OriginAccessIdentity: '' } }] },
      DefaultCacheBehavior: {
        TargetOriginId: 'site', ViewerProtocolPolicy: 'redirect-to-https', Compress: true,
        AllowedMethods: { Quantity: 2, Items: ['GET', 'HEAD'], CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] } },
        CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6',
      },
      CustomErrorResponses: {
        Quantity: 2,
        Items: [403, 404].map((code) => ({
          ErrorCode: code, ResponsePagePath: '/index.html', ResponseCode: '200', ErrorCachingMinTTL: 60,
        })),
      },
    };
    const dist = aws(['cloudfront', 'create-distribution', '--distribution-config', JSON.stringify(config)]).Distribution;
    DISTRIBUTION = dist.Id;
    const account = dist.ARN.split(':')[4];
    aws(['s3api', 'put-bucket-policy', '--bucket', BUCKET, '--policy', JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Sid: 'CloudFrontRead', Effect: 'Allow', Principal: { Service: 'cloudfront.amazonaws.com' },
        Action: 's3:GetObject', Resource: `arn:aws:s3:::${BUCKET}/*`,
        Condition: { StringEquals: { 'AWS:SourceArn': `arn:aws:cloudfront::${account}:distribution/${DISTRIBUTION}` } } }],
    })], { json: false });
    console.log(`  created ${DISTRIBUTION} → ${dist.DomainName} (global deploy takes ~5 min)`);
  }
}

// -------------------------------------------------------------------- dns
if (!has('skip-infra') && !has('skip-dns') && DOMAIN && DISTRIBUTION) {
  step(`dns for ${DOMAIN}`);
  const zones = aws(['route53', 'list-hosted-zones'], { allowFail: true })?.HostedZones ?? [];
  const zone = zones
    .filter((z) => `${DOMAIN}.`.endsWith(z.Name))
    .sort((a, b) => b.Name.length - a.Name.length)[0];
  if (!zone) {
    console.log('  no Route53 zone for this domain here — point your DNS at the distribution manually');
  } else {
    const target = aws(['cloudfront', 'get-distribution', '--id', DISTRIBUTION]).Distribution.DomainName;
    const names = WILDCARD ? [DOMAIN, `*.${DOMAIN}`] : [DOMAIN];
    const changes = names.flatMap((name) => ['A', 'AAAA'].map((type) => ({
      Action: 'UPSERT',
      ResourceRecordSet: {
        Name: `${name}.`, Type: type,
        // Z2FDTNDATAQYW2 is CloudFront's fixed alias zone id
        AliasTarget: { HostedZoneId: 'Z2FDTNDATAQYW2', DNSName: `${target}.`, EvaluateTargetHealth: false },
      },
    })));
    aws(['route53', 'change-resource-record-sets', '--hosted-zone-id', zone.Id,
      '--change-batch', JSON.stringify({ Comment: 'viewer aliases', Changes: changes })]);
    console.log(`  upserted ${names.join(', ')} → ${target}`);
  }
}

// ------------------------------------------------------------- build + ship
if (!has('skip-build')) {
  step('build');
  if (spawnSync('npx', ['vite', 'build'], { stdio: 'inherit' }).status !== 0) process.exit(1);
}
if (!has('skip-upload')) {
  step(`upload to s3://${BUCKET}`);
  aws(['s3', 'sync', 'dist/assets', `s3://${BUCKET}/assets`,
    '--cache-control', 'public,max-age=31536000,immutable', '--delete'], { json: false });
  aws(['s3', 'cp', 'dist/index.html', `s3://${BUCKET}/index.html`,
    '--cache-control', 'public,max-age=60', '--content-type', 'text/html; charset=utf-8'], { json: false });
  if (DISTRIBUTION) {
    aws(['cloudfront', 'create-invalidation', '--distribution-id', DISTRIBUTION, '--paths', '/index.html'], { json: false });
  }
  console.log('  uploaded (immutable assets, fresh index.html)');
}
console.log(`\ndone${DOMAIN ? ` — https://${DOMAIN}` : ''}`);
