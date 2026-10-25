#!/usr/bin/env bash
# The full publication peak (constraint 5): 300 writers keep writing while 15 000 visitors
# hit a 500-copy link. Run from tests/ with API_URL, WS_URL, FRONT_URL set.
set -u
RUN=${RUN_ID:-$(date -u +%Y%m%d%H%M%S)}; export RUN_ID=$RUN
mkdir -p results
WRITERS=${WRITERS:-300} DOCS=${DOCS:-30} DURATION=${DURATION:-420} node load/writers.mjs > results/writers-$RUN.log 2>&1 &
WPID=$!
until grep -q "starting to write" results/writers-$RUN.log 2>/dev/null; do sleep 2; done
sleep 20 # writers are now all writing
LINK=$(node -e "import('./lib.mjs').then(async ({ endpoints, must, session }) => {
  const { api } = endpoints(); const s = await session(api, 'Association', 'association-$RUN@test.collabdoc.invalid')
  const d = await must(api, 'POST', '/documents', { title: 'Journal annuel (pic $RUN)' }, s.token)
  const l = await must(api, 'POST', '/documents/' + d.docId + '/links', { maxDownloads: 500 }, s.token); console.log(l.linkId) })")
echo "link $LINK (500 copies) - publication at $(date -u +%T)"
(while kill -0 $WPID 2>/dev/null; do echo "$(date -u +%T) load: $(cut -d' ' -f1-3 /proc/loadavg) mem_free_mb: $(free -m | awk '/Mem/{print $7}')"; sleep 15; done) > results/loadgen-host-$RUN.log &
k6 run --quiet -e API_URL="$API_URL" -e FRONT_URL="$FRONT_URL" -e LINK_ID="$LINK" -e RUN_ID="$RUN" load/spike.js 2> results/k6-$RUN.err || true
echo "--- final link state:"; curl -s "$API_URL/links/$LINK"; echo
echo "--- waiting for writers to finish..."; wait $WPID
tail -25 results/writers-$RUN.log
echo "--- load generator host:"; tail -4 results/loadgen-host-$RUN.log
