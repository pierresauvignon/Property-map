#!/usr/bin/env bash
# Push the current web/ and api/ to AWS. Safe to run any time.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/lib.sh
: "${DIST_ID:?no infra/.state — run infra/provision.sh first}"

echo "→ site"
for f in index.html app.js sw.js bookmarklet.html; do
  aws s3 cp "web/$f" "s3://$WEB_BUCKET/$f" --cache-control "no-cache" \
    --content-type "$([ "${f##*.}" = html ] && echo 'text/html; charset=utf-8' || echo 'application/javascript; charset=utf-8')" >/dev/null
done
aws s3 cp web/manifest.webmanifest "s3://$WEB_BUCKET/manifest.webmanifest" --cache-control "no-cache" --content-type "application/manifest+json" >/dev/null
aws s3 cp web/properties.js "s3://$WEB_BUCKET/properties.js" --cache-control "max-age=300" --content-type "application/javascript; charset=utf-8" >/dev/null

echo "→ api"
bash api/deploy.sh >/dev/null
aws lambda wait function-updated --function-name "$FUNCTION_NAME"

echo "→ invalidate"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" --query 'Invalidation.Status' --output text
