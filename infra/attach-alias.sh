#!/usr/bin/env bash
# Attach DOMAIN (from infra/config.sh) to the CloudFront distribution.
# Run this AFTER the ACM certificate reports ISSUED, i.e. after you have added
# the validation CNAME that provision.sh printed at your DNS host.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
: "${DOMAIN:?set DOMAIN in infra/config.sh}"
: "${DIST_ID:?no infra/.state — run infra/provision.sh first}"

CERT=$(aws acm list-certificates --region us-east-1 \
  --query "CertificateSummaryList[?DomainName=='${DOMAIN}'].CertificateArn" --output text | head -n1)
[ -n "$CERT" ] && [ "$CERT" != "None" ] || { echo "No certificate for $DOMAIN — run provision.sh first." >&2; exit 1; }

STATUS=$(aws acm describe-certificate --certificate-arn "$CERT" --region us-east-1 \
          --query 'Certificate.Status' --output text)
echo "certificate: $STATUS"
if [ "$STATUS" != "ISSUED" ]; then
  echo "Certificate is not ISSUED yet — add the validation CNAME at your DNS host first."
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
aws cloudfront get-distribution-config --id "$DIST_ID" --output json > "$TMP/dc.json"
ETAG=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['ETag'])" "$TMP/dc.json")

python3 - "$DOMAIN" "$CERT" "$TMP" <<'PY'
import json, sys
domain, cert, tmp = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(tmp + '/dc.json'))['DistributionConfig']
d['Aliases'] = {'Quantity': 1, 'Items': [domain]}
d['ViewerCertificate'] = {
    'ACMCertificateArn': cert,
    'SSLSupportMethod': 'sni-only',
    'MinimumProtocolVersion': 'TLSv1.2_2021',
    'Certificate': cert,
    'CertificateSource': 'acm',
}
json.dump(d, open(tmp + '/new.json', 'w'))
PY

aws cloudfront update-distribution --id "$DIST_ID" --if-match "$ETAG" \
  --distribution-config "file://$TMP/new.json" --query 'Distribution.Status' --output text
echo "Alias attached. Now point $DOMAIN at the distribution with a CNAME:"
echo "  $DOMAIN  CNAME  $DIST_DOMAIN."
