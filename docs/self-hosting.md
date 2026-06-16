# Self-hosting the Tracelog viewer

The viewer is a static, entirely client-side app: it reads gzipped JSONL straight
from *your* S3 logs bucket and renders it in the browser. There is no viewer
server and no tenancy — so "self-hosting" just means serving the same `dist/`
bytes from infrastructure you control.

You'd do this if you'd rather not load the app from `tracelog.org` with your
read-only keys, if you want it inside your own VPC/firewall, or if you've forked
it.

There are two routes:

- **[Part 1 — the turnkey AWS deployer](#part-1--the-turnkey-aws-deployer):** one
  script provisions S3 + CloudFront + ACM + Route 53 in your account and ships the
  app to `*.tracelog.example.com` (or whatever domain you choose). Recommended.
- **[Part 2 — any static file server](#part-2--any-static-file-server):** build
  `dist/` and serve it however you like (Nginx, Caddy, R2, GitHub Pages, …).

> **Two different buckets.** Keep these straight throughout:
> - the **logs bucket** — where your tracelog agent writes the JSONL the viewer reads;
> - the **site bucket** — where the static app is served from (Part 1 creates this for you).
>
> They can live in the same AWS account but are otherwise unrelated.

---

## How the domain model works (read this first)

The viewer turns **subdomains into workspaces**. Each subdomain is a separate
browser origin, so the browser silos its storage automatically: visiting
`alpha.tracelog.example.com` and `beta.tracelog.example.com` gives you two fully
independent workspaces — separate saved connections, separate local caches — with
**zero** server-side tenancy. Creating a workspace provisions nothing; the
wildcard domain already resolves for every label.

That means a self-host wants a **wildcard subdomain** of an **apex** you pick:

```
            apex (landing page + workspace launcher)
            │
   tracelog.example.com
   │
   ├── alpha.tracelog.example.com     ← a workspace
   ├── beta.tracelog.example.com      ← another workspace
   └── *.tracelog.example.com         ← all served the identical app
```

The apex itself (`tracelog.example.com`) is **not** a workspace — it's the public
landing page and the keeper of the per-device workspace directory.

### Telling the app what its apex is

The app normally derives the apex from the hostname's registrable domain
(eTLD+1) — for `*.tracelog.org` that's `tracelog.org`, with zero configuration.
But if your apex is *itself* a sub-level — like `tracelog.example.com`, whose
registrable domain is `example.com` — the hostname alone is ambiguous (the app
can't tell `tracelog.example.com` the apex from a `tracelog` workspace under
`example.com`). So the apex is declared explicitly in a meta tag:

```html
<meta name="tracelog:apex" content="tracelog.example.com" />
```

**The deployer writes this for you** from `--domain` (Part 1). If you serve the
app yourself (Part 2), set it manually. An absent/placeholder tag falls back to
eTLD+1, so a deployment whose apex *is* the registrable domain
(`tracelog.example.com` served at apex `example.com`, say) needs nothing.

A single-origin host with no apex at all (plain `localhost`, or one bare domain
with no subdomains) skips the workspace machinery entirely and degrades to a
local-only profile switcher — fine for a personal, single-bucket setup.

---

## Part 1 — the turnkey AWS deployer

[`scripts/deploy-site.mjs`](../scripts/deploy-site.mjs) is a zero-dependency
provision-or-adopt deployer. It shells out to the `aws` CLI (so your profile /
SSO works as usual), creates whatever doesn't exist, adopts whatever does, and is
safe to run repeatedly.

### Before you start

- An **AWS account** and the **`aws` CLI** configured (`aws sts get-caller-identity`
  should succeed). Use `AWS_PROFILE=…` to pick a profile.
- **Node.js** (to run the script and the Vite build).
- A **domain** you control. If its DNS is in Route 53 *in this account*, the
  deployer wires up DNS for you; otherwise you'll point DNS at the distribution
  manually (it tells you the target).
- Your **logs bucket** already receiving data from the tracelog agent.

### 1. Request an ACM certificate (in us-east-1)

CloudFront only accepts certificates from **us-east-1**, so request it there
regardless of where your buckets live. It must cover both the apex and the
workspace wildcard:

- `tracelog.example.com`
- `*.tracelog.example.com`

```sh
aws acm request-certificate --region us-east-1 \
  --domain-name tracelog.example.com \
  --subject-alternative-names '*.tracelog.example.com' \
  --validation-method DNS
```

Complete the DNS validation (add the CNAME ACM gives you) and wait for the cert
to reach **ISSUED**. The deployer auto-discovers an ISSUED us-east-1 cert whose
name matches `tracelog.example.com` or `*.tracelog.example.com`; if you'd rather
be explicit, pass its ARN with `--cert`.

### 2. Run the deployer

```sh
AWS_PROFILE=me node scripts/deploy-site.mjs \
  --bucket my-tracelog-site \
  --domain tracelog.example.com
```

- `--bucket` is the **site** bucket (it'll be created private, behind CloudFront —
  not the logs bucket).
- `--domain` is your **apex**. The deployer stamps it into the app's apex meta tag
  and provisions the apex **and** the `*.` wildcard alias.

The CSP ships **report-only** by default so you can watch for violations before
enforcing; add `--csp-enforce` once you're happy. See the
[full flag list](#deployer-flags) below.

### 3. What it provisioned

- **S3 site bucket** — private, public access blocked, read only via CloudFront
  Origin Access Control.
- **CloudFront distribution** — `tracelog.example.com` + `*.tracelog.example.com`
  aliases, HTTP/2+3, the ACM cert, an SPA fallback (403/404 → `/index.html`), and
  a response-headers policy carrying the CSP + hardening headers.
- **Route 53** alias records (A/AAAA) for the apex and wildcard, *if* the hosted
  zone is in this account.
- **The built app**, uploaded with the apex meta stamped in.

Global propagation takes a few minutes on first create.

### 4. Point your logs bucket at the viewer

Two one-time changes on the **logs** bucket (not the site bucket):

**a. CORS** — let the workspace subdomains read it. S3 allows one wildcard per
origin, and `*.apex` covers every workspace (the bare apex never fetches data):

```json
{
  "CORSRules": [{
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": ["https://*.tracelog.example.com"],
    "ExposeHeaders": ["ETag", "Content-Length", "Last-Modified", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }]
}
```

`ListObjectsV2` is a GET on the bucket URL, so this single rule covers both
listing and fetching. The viewer fetches finalized files with `Range: bytes=0-`
to cache the stored gzip bytes un-inflated; `"AllowedHeaders": ["*"]` already
permits `Range` — if you narrow that list, keep `Range` in it. (Add
`"http://localhost:5173"` to `AllowedOrigins` only if you'll run the dev server
against this bucket.)

**b. A dedicated read-only IAM user**, scoped to this bucket only. **Never** paste
an admin key into a web page — even your own.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:ListBucket"],
    "Resource": [
      "arn:aws:s3:::YOUR-LOGS-BUCKET",
      "arn:aws:s3:::YOUR-LOGS-BUCKET/*"
    ]
  }]
}
```

Create an access key for that user; you'll paste it into the workspace's
connection form. (Prefer no keys at all? A bucket whose policy allows anonymous
`ListBucket` + `GetObject` can be connected as **public** — the form then hides
all auth fields.)

### 5. Open a workspace

Visit any subdomain — e.g. `https://alpha.tracelog.example.com` — and connect a
profile: bucket name, region, the read-only key (and an optional key prefix if
your channels live under `logs/` rather than the bucket root), then pick a time
range. Everything else — discovery, fetching, parsing, caching — is automatic.
The bare apex (`https://tracelog.example.com`) is the launcher for creating and
hopping between workspaces.

---

## Part 2 — any static file server

The built app is just static files; it needs no AWS hosting.

```sh
npm install
npm run build      # → dist/
```

Then serve `dist/` from any static server, with three requirements:

1. **SPA fallback** — unknown paths must serve `/index.html` (the app routes on
   the URL hash, but a deep link or refresh still has to land on `index.html`).
2. **The apex meta tag** — if your apex is a sub-level (see
   [the domain model](#how-the-domain-model-works-read-this-first)), set it in
   `index.html` before/while serving:
   ```html
   <meta name="tracelog:apex" content="tracelog.example.com" />
   ```
   (or build with it already in place). Skip this if your apex is the registrable
   domain, or if you're single-origin with no subdomains.
3. **The Content-Security-Policy** — set it as a response header at your server
   (see below). The CloudFront path sets it for you; a plain static server does
   not.

For workspaces to work you still need the wildcard subdomain (`*.apex`) pointing
at your server and a TLS cert covering it — that part is the same regardless of
how you serve the bytes. Without subdomains you get a single local-only
workspace, which is fine for personal use.

---

## Customizing the Content-Security-Policy

The viewer's trust guarantee is in the CSP: the page and its same-origin worker
(where the S3 SDK runs) can reach **only** this origin and Amazon S3, and nowhere
else. `script-src` is strict `'self'` (no eval/Function/wasm, no inline scripts).
The canonical policy lives in
[`scripts/deploy-site.mjs`](../scripts/deploy-site.mjs):

```
default-src 'self';
script-src 'self';
worker-src 'self';
connect-src 'self' https://*.amazonaws.com;
img-src 'self' data:;
style-src 'self' 'unsafe-inline';
font-src 'self';
object-src 'none'; base-uri 'self'; form-action 'none';
frame-src 'none'; frame-ancestors 'none'
```

If your logs live behind a **custom domain** or an **S3-compatible endpoint**
(Cloudflare R2, MinIO, …), widen **`connect-src`** to allow that origin — e.g.
`connect-src 'self' https://logs.example.com`. That's the only directive you
should need to touch.

---

## Updating / redeploying

Re-run the same deployer command. With infra already in place it adopts the
distribution and just rebuilds + re-uploads + invalidates `index.html` (assets
are content-hashed and immutable). Useful skips:

- `--skip-infra` — app-only redeploy (build + upload + invalidate); skips
  bucket/distribution/DNS.
- `--csp-enforce` — flip the CSP from report-only to enforced (re-runnable).

---

## Troubleshooting

- **A subdomain shows the apex landing page, or workspaces look wrong.** The apex
  meta tag is missing or incorrect for a sub-level apex. Confirm
  `<meta name="tracelog:apex">` matches your real apex (the deployer prints
  `apex meta: …` during upload).
- **Empty charts / CORS errors in the console.** The logs bucket CORS doesn't
  allow `https://*.your-apex`, or you're on the bare apex (which never fetches —
  use a workspace subdomain).
- **`no ISSUED us-east-1 ACM cert found`.** Request the cert in **us-east-1**
  covering both the apex and `*.apex`, finish DNS validation, then re-run (or
  pass `--cert`).
- **A just-deployed change isn't showing up.** The store runs in a SharedWorker;
  close all tabs for that origin so the old worker is released, then reload.
- **DNS wasn't created.** The Route 53 zone isn't in this account — point your
  apex and `*.apex` at the CloudFront distribution domain manually (the deployer
  prints it).

---

## Deployer flags

| Flag | Meaning |
|------|---------|
| `--bucket NAME` | **Required.** The S3 **site** bucket (created/adopted). |
| `--domain HOST` | The deployment **apex** (e.g. `tracelog.example.com`). Drives the CloudFront aliases, DNS, and the stamped apex meta tag. Omit to stop at the bucket and front it yourself. |
| `--cert ARN` | ACM cert ARN (us-east-1). Omit to auto-discover by name. |
| `--distribution ID` | Adopt an existing CloudFront distribution instead of finding/creating one. |
| `--no-wildcard` | Provision only the apex alias, not `*.apex` (disables subdomain workspaces). |
| `--csp-enforce` | Enforce the CSP (default is report-only). |
| `--skip-infra` | Skip bucket/distribution/DNS — just build, upload, invalidate. |
| `--skip-dns` | Skip Route 53 record creation. |
| `--skip-build` | Don't run `vite build`; upload the existing `dist/`. |
| `--skip-upload` | Provision infra only; don't upload the app. |
| `--skip-headers` | Don't create/attach the CSP response-headers policy. |

---

## See also

- The [`tracelog` agent README](https://github.com/redthreadlabs/tracelog) — how
  your service writes the JSONL the viewer reads.
- `SPEC.md` §2 (bucket prerequisites), §4 (security model), §10 (workspace and
  apex decisions) in this repo.
