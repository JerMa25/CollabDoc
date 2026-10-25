#!/usr/bin/env bash
# Temporary load generator in the application's region (tests/load/loadgen.yaml), driven by
# SSM Run Command: no SSH key, no open port. Results come back into tests/results/.
#
#   ./scripts/loadtest.sh up                 create the machine (~3 min) and copy the tests to it
#   ./scripts/loadtest.sh run '<commands>'   run commands in tests/ on the machine, print the output
#   ./scripts/loadtest.sh pull               copy tests/results/* back from the machine
#   ./scripts/loadtest.sh down               delete the machine and everything created with it
#
# Inside 'run', API_URL / WS_URL / FRONT_URL point to the deployed application.
set -euo pipefail
cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-eu-north-1}"
STACK=collabdoc-loadgen

out() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }

case "${1:-}" in
  up)
    aws cloudformation deploy --region "$REGION" --stack-name "$STACK" --template-file tests/load/loadgen.yaml \
      --capabilities CAPABILITY_IAM --tags project=collabdoc-loadtest --no-fail-on-empty-changeset
    ID=$(out $STACK InstanceId)
    echo "instance $ID: waiting for SSM agent..."
    until [ "$(aws ssm describe-instance-information --region "$REGION" --filters Key=InstanceIds,Values="$ID" --query 'length(InstanceInformationList)' --output text)" = "1" ]; do sleep 10; done
    "$0" run 'until [ -f /var/tmp/loadgen-ready ]; do sleep 5; done; node --version; k6 version; echo READY'
    ;;

  push)
    B=$(out $STACK BucketName)
    tar czf /tmp/collabdoc-tests.tgz --exclude=node_modules --exclude='results/*' tests
    aws s3 cp --region "$REGION" --only-show-errors /tmp/collabdoc-tests.tgz "s3://$B/tests.tgz"
    ;;

  run)
    [ -n "${2:-}" ] || { echo "usage: $0 run '<commands>'"; exit 1; }
    ID=$(out $STACK InstanceId); B=$(out $STACK BucketName)
    "$0" push
    {
      echo "set -e; export HOME=/root"
      echo "export API_URL='$(out collabdoc ApiUrl)' WS_URL='$(out collabdoc WebSocketUrl)' FRONT_URL='$(out collabdoc FrontendUrl)'"
      echo "mkdir -p /opt/run && cd /opt/run && aws s3 cp --only-show-errors s3://$B/tests.tgz . && tar xzf tests.tgz && cd tests"
      echo "[ -d node_modules ] || npm ci --no-audit --no-fund --silent"
      echo "ulimit -n 200000"
      echo "$2"
      echo "aws s3 cp --only-show-errors --recursive results s3://$B/results/ || true"
    } > /tmp/collabdoc-run.sh
    aws s3 cp --region "$REGION" --only-show-errors /tmp/collabdoc-run.sh "s3://$B/run.sh"
    CMD=$(aws ssm send-command --region "$REGION" --instance-ids "$ID" --document-name AWS-RunShellScript \
      --timeout-seconds 600 --parameters "{\"executionTimeout\":[\"3600\"],\"commands\":[\"aws s3 cp --only-show-errors s3://$B/run.sh /tmp/run.sh && bash /tmp/run.sh 2>&1 | tee /var/tmp/last-run.log | tail -c 20000\"]}" \
      --query Command.CommandId --output text)
    while :; do
      S=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$ID" --query Status --output text 2>/dev/null || echo Pending)
      case "$S" in Pending|InProgress|Delayed) sleep 10 ;; *) break ;; esac
    done
    aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$ID" --query StandardOutputContent --output text
    echo "[remote status: $S]"
    ;;

  pull)
    B=$(out $STACK BucketName)
    aws s3 cp --region "$REGION" --only-show-errors --recursive "s3://$B/results/" tests/results/
    ls -1 tests/results/
    ;;

  down)
    B=$(out $STACK BucketName 2>/dev/null || true)
    [ -n "$B" ] && [ "$B" != "None" ] && aws s3 rm --region "$REGION" --recursive --only-show-errors "s3://$B"
    aws cloudformation delete-stack --region "$REGION" --stack-name "$STACK"
    aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$STACK"
    echo "load generator deleted"
    ;;

  *)
    sed -n '2,11p' "$0"; exit 1 ;;
esac
