#!/usr/bin/env bash
# Wait for the ACM cert to validate, then register pentesterflow.com on the
# CloudFront distribution (alias + ACM cert). Idempotent-ish; safe to re-run.
set -euo pipefail

REGION="us-east-1"
DIST_ID="E17EHMI0HM87IP"
DOMAIN="pentesterflow.com"
ARN="$(cat "$(dirname "$0")/acm-arn.txt")"

echo "▸ waiting for ACM cert to validate (add the CNAME in Cloudflare, DNS-only)…"
for i in $(seq 1 120); do          # up to ~60 min (30s * 120)
  STATUS=$(aws acm describe-certificate --region "$REGION" --certificate-arn "$ARN" \
    --query 'Certificate.Status' --output text)
  echo "   [$i] cert status: $STATUS"
  [ "$STATUS" = "ISSUED" ] && break
  [ "$STATUS" = "FAILED" ] && { echo "✗ cert FAILED"; exit 1; }
  sleep 30
done
[ "$STATUS" = "ISSUED" ] || { echo "✗ timed out waiting for validation"; exit 1; }

echo "▸ fetching current distribution config…"
aws cloudfront get-distribution-config --id "$DIST_ID" > /tmp/pf_distcfg.json
ETAG=$(python3 -c "import json;print(json.load(open('/tmp/pf_distcfg.json'))['ETag'])")

echo "▸ patching aliases + viewer certificate…"
python3 - "$ARN" "$DOMAIN" <<'PY'
import json, sys
arn, domain = sys.argv[1], sys.argv[2]
d = json.load(open('/tmp/pf_distcfg.json'))
cfg = d['DistributionConfig']
cfg['Aliases'] = {"Quantity": 1, "Items": [domain]}
cfg['ViewerCertificate'] = {
    "ACMCertificateArn": arn,
    "SSLSupportMethod": "sni-only",
    "MinimumProtocolVersion": "TLSv1.2_2021",
    "Certificate": arn,
    "CertificateSource": "acm",
}
json.dump(cfg, open('/tmp/pf_distcfg_new.json', 'w'))
print("patched")
PY

echo "▸ updating distribution…"
aws cloudfront update-distribution --id "$DIST_ID" \
  --distribution-config file:///tmp/pf_distcfg_new.json \
  --if-match "$ETAG" \
  --query '{Status:Distribution.Status, Aliases:Distribution.DistributionConfig.Aliases.Items}' --output json

echo "✓ alias + cert attached. Distribution is redeploying (a few minutes)."
echo "  Reminder: set Cloudflare SSL/TLS mode to Full (strict)."
