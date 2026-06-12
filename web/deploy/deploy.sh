#!/usr/bin/env bash
# Build and deploy the PentesterFlow static site to S3 + CloudFront.
# Usage: ./deploy/deploy.sh   (run from the web/ directory)
set -euo pipefail

BUCKET="pentesterflow-web-111315604409"
DISTRIBUTION_ID="E17EHMI0HM87IP"

echo "▸ building…"
npm run build

echo "▸ uploading hashed assets (1y immutable)…"
aws s3 sync dist/ "s3://$BUCKET/" --delete \
  --cache-control "public,max-age=31536000,immutable" \
  --exclude "index.html"

echo "▸ uploading index.html (no-cache)…"
aws s3 cp dist/index.html "s3://$BUCKET/index.html" \
  --cache-control "no-cache" --content-type "text/html; charset=utf-8"

echo "▸ invalidating CloudFront cache…"
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" \
  --paths "/index.html" "/" --query 'Invalidation.Id' --output text

echo "✓ deployed → https://$(aws cloudfront get-distribution --id "$DISTRIBUTION_ID" --query 'Distribution.DomainName' --output text)"
