#!/usr/bin/env bash
# Server-side view of a test window, from CloudWatch: per Lambda function (invocations, errors,
# throttles, max concurrency, p99 duration), HTTP API (requests, 4xx, 5xx, p99 latency),
# WebSocket API messages, DynamoDB throttled requests.
# Usage: tests/load/cloudwatch-metrics.sh <start ISO UTC> <end ISO UTC> > tests/results/cloudwatch-<run>.json
set -euo pipefail
START=$1; END=$2; REGION=${AWS_REGION:-eu-north-1}; STACK=collabdoc
res() { aws cloudformation describe-stack-resource --region "$REGION" --stack-name $STACK --logical-resource-id "$1" --query StackResourceDetail.PhysicalResourceId --output text; }
stat() { # namespace metric dimName dimValue statistic
  local s=$5 q='Datapoints[].Sum'; case $s in Maximum) q='Datapoints[].Maximum';; esac
  local ext=(); [[ $s == p* ]] && ext=(--extended-statistics "$s") && q="Datapoints[].ExtendedStatistics.\"$s\"" || ext=(--statistics "$s")
  aws cloudwatch get-metric-statistics --region "$REGION" --namespace "$1" --metric-name "$2" --dimensions Name="$3",Value="$4" \
    --start-time "$START" --end-time "$END" --period 60 "${ext[@]}" --query "$q" --output json |
    node -e "const a=JSON.parse(require('fs').readFileSync(0));const s='$s';process.stdout.write(String(a.length?Math.round((s==='Sum'?a.reduce((x,y)=>x+y,0):Math.max(...a))*10)/10:0))"
}
echo "{ \"window\": { \"start\": \"$START\", \"end\": \"$END\" },"
echo "  \"lambda\": {"
first=1
for f in ApiFunction UpdateFunction ClaimFunction AdminFunction WsConnectFunction WsDisconnectFunction WsMessageFunction NotifyFunction SnapshotFunction; do
  n=$(res $f)
  [ $first = 1 ] || echo ","; first=0
  printf '    "%s": { "invocations": %s, "errors": %s, "throttles": %s, "maxConcurrency": %s, "durationP99ms": %s }' "$f" \
    "$(stat AWS/Lambda Invocations FunctionName "$n" Sum)" "$(stat AWS/Lambda Errors FunctionName "$n" Sum)" \
    "$(stat AWS/Lambda Throttles FunctionName "$n" Sum)" "$(stat AWS/Lambda ConcurrentExecutions FunctionName "$n" Maximum)" \
    "$(stat AWS/Lambda Duration FunctionName "$n" p99)"
done
echo; echo "  },"
H=$(res HttpApi); W=$(res WebSocketApi)
printf '  "httpApi": { "requests": %s, "4xx": %s, "5xx": %s, "latencyP99ms": %s },\n' \
  "$(stat AWS/ApiGateway Count ApiId "$H" Sum)" "$(stat AWS/ApiGateway 4xx ApiId "$H" Sum)" "$(stat AWS/ApiGateway 5xx ApiId "$H" Sum)" "$(stat AWS/ApiGateway Latency ApiId "$H" p99)"
printf '  "webSocketApi": { "messages": %s, "connects": %s },\n' "$(stat AWS/ApiGateway MessageCount ApiId "$W" Sum)" "$(stat AWS/ApiGateway ConnectCount ApiId "$W" Sum)"
echo '  "dynamodbThrottledRequests": {'
first=1
for t in DocumentsTable MembersTable UpdatesTable CreditsTable ConnectionsTable LinksTable ClaimsTable VersionsTable AbuseTable; do
  [ $first = 1 ] || echo ","; first=0
  printf '    "%s": %s' "$t" "$(stat AWS/DynamoDB ThrottledRequests TableName "$(res $t)" Sum)"
done
echo; echo "  }"; echo "}"
