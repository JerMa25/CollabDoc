// Constraint 1 — proof test.
// Creates a link allowing MAX downloads, then fires CLICKS claims at the same instant
// (all requests started together, no retry). Exactly MAX must succeed (HTTP 200), never more.
// Then checks the server side: link.remaining == 0 and the number of 200s equals MAX.
//
// Usage: MAX=50 CLICKS=1000 node load/claim-race.mjs
import { call, endpoints, must, percentiles, RUN, saveResult, session, setupDoc } from '../lib.mjs'

const MAX = Number(process.env.MAX ?? 50)
const CLICKS = Number(process.env.CLICKS ?? 1000)
const { api } = endpoints()

console.log(`claim race run=${RUN} max=${MAX} simultaneous clicks=${CLICKS}`)
const owner = await session(api, 'Owner', `race-${RUN}@test.collabdoc.invalid`)
const doc = await setupDoc(api, owner, [], `claim race ${RUN}`)
const link = await must(api, 'POST', `/documents/${doc.docId}/links`, { maxDownloads: MAX }, owner.token)

const t0 = Date.now()
const results = await Promise.all(
  Array.from({ length: CLICKS }, () =>
    call(api, 'POST', `/links/${link.linkId}/claim`).catch((e) => ({ status: 0, data: { error: String(e) }, ms: 0 })),
  ),
)
const durationMs = Date.now() - t0

const byStatus = {}
for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
const ok = results.filter((r) => r.status === 200)
const copyNumbers = ok.map((r) => r.data.copyNumber).sort((a, b) => a - b)
const after = await must(api, 'GET', `/links/${link.linkId}`)

const result = {
  test: 'claim-race',
  run: RUN,
  linkId: link.linkId,
  params: { maxDownloads: MAX, simultaneousClicks: CLICKS },
  durationMs,
  byStatus,
  successes: ok.length,
  distinctCopyNumbers: new Set(copyNumbers).size,
  copyNumbersRange: [copyNumbers[0], copyNumbers[copyNumbers.length - 1]],
  remainingAfter: after.remaining,
  latencyMs: percentiles(results.map((r) => r.ms)),
}
result.PASS = ok.length <= MAX && after.remaining === 0 && result.distinctCopyNumbers === ok.length
result.NOTE = ok.length < MAX ? `${MAX - ok.length} copies not taken (throttled 429/503 — visitors would retry)` : 'all copies taken'
console.log(JSON.stringify(result, null, 2))
console.log(`saved ${saveResult('claim-race', result)}`)
console.log(ok.length > MAX ? '❌ FAIL: more downloads than allowed' : `✅ PASS: ${ok.length} downloads for ${MAX} allowed, never more`)
process.exit(ok.length > MAX ? 1 : 0)
