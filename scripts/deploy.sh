#!/usr/bin/env bash
# Builds and deploys everything: backend (SAM/CloudFormation) then frontend (S3 + CloudFront).
# Usage: NOTIFY_EMAIL=you@example.com ./scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-eu-north-1}"
STACK=collabdoc
: "${NOTIFY_EMAIL:?Set NOTIFY_EMAIL to the SES-verified sender address}"

echo "==> Backend: test + bundle"
(cd backend && npm ci --no-audit --no-fund && npm test && npm run build)

echo "==> Infrastructure: sam deploy"
sam deploy --region "$REGION" --parameter-overrides "NotificationSender=$NOTIFY_EMAIL"

out() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
API_URL=$(out ApiUrl); WS_URL=$(out WebSocketUrl); FRONT_URL=$(out FrontendUrl)
BUCKET=$(out FrontendBucketName); DIST=$(out DistributionId)

echo "==> Frontend: build + upload"
(cd frontend && npm ci --no-audit --no-fund && npm run build)
printf "window.COLLABDOC_CONFIG = { apiUrl: '%s', wsUrl: '%s' }\n" "$API_URL" "$WS_URL" > frontend/dist/config.js
aws s3 sync frontend/dist "s3://$BUCKET" --delete --region "$REGION" \
  --exclude index.html --exclude config.js --cache-control "public, max-age=31536000, immutable"
aws s3 cp frontend/dist/index.html "s3://$BUCKET/index.html" --region "$REGION" --cache-control "no-cache"
aws s3 cp frontend/dist/config.js "s3://$BUCKET/config.js" --region "$REGION" --cache-control "no-cache" --content-type application/javascript
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/index.html" "/config.js" >/dev/null

cat <<MSG

Deployed.
  Frontend : $FRONT_URL
  API      : $API_URL
  WebSocket: $WS_URL
  Admin    : $FRONT_URL/#/admin
MSG
