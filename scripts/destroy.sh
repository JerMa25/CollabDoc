#!/usr/bin/env bash
# Deletes everything created by this project (buckets are emptied first, as CloudFormation requires).
set -euo pipefail
REGION="${AWS_REGION:-eu-north-1}"
STACK=collabdoc
out() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null || true; }

for b in "$(out FrontendBucketName)" "$(out DataBucketName)"; do
  [ -n "$b" ] && [ "$b" != "None" ] && aws s3 rm "s3://$b" --recursive --region "$REGION" && echo "emptied $b"
done
sam delete --stack-name "$STACK" --region "$REGION" --no-prompts
aws ssm delete-parameters --region "$REGION" --names /collabdoc/session-secret /collabdoc/admin-token >/dev/null || true
echo "Stack, buckets, notification topic (and its subscriptions) and secrets deleted."
