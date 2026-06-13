#!/usr/bin/env bash
# Deploy the viewer to its static host (SPEC §10: tracelog.org, one
# distribution serving identical bytes to every workspace subdomain).
#
#   AWS_PROFILE=redthread ./scripts/deploy-site.sh
#
# Self-hosters: set BUCKET/DISTRIBUTION_ID (or just `vite build` and copy
# dist/ anywhere — the app is relative-pathed static files, nothing more).
set -euo pipefail
cd "$(dirname "$0")/.."

BUCKET="${BUCKET:-tracelog-org-site}"
DISTRIBUTION_ID="${DISTRIBUTION_ID:-E3B4UTXPAPQSMG}"

npx vite build

# hashed assets are immutable: cache forever
aws s3 sync dist/assets "s3://$BUCKET/assets" \
  --cache-control "public,max-age=31536000,immutable" --delete

# the entry point names the current hashes: keep it fresh
aws s3 cp dist/index.html "s3://$BUCKET/index.html" \
  --cache-control "public,max-age=60" --content-type "text/html; charset=utf-8"

aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" \
  --paths "/index.html" --query 'Invalidation.Id' --output text
echo "deployed to s3://$BUCKET (invalidation issued)"
