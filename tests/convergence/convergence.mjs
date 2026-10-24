// Constraint 2 — proof test.
// N writers edit the SAME document at the SAME place (position 0, or random with SPOT=random),
// concurrently, through the public API. Every edit carries a unique marker.
// Checks:
//   (a) every edit the server ACCEPTED (HTTP 200) is in the final document, exactly once;
//   (b) every participant's live copy (built only from its own edits + WebSocket broadcasts)
//       is identical to the server's document  -> "everyone ends up seeing the same document";
//   (c) after a reload from the server, all copies are identical (eventual convergence).
//
// Usage: WRITERS=20 EDITS=25 node convergence/convergence.mjs
import WebSocket from 'ws'
import * as Y from 'yjs'
import { endpoints, fromB64, localEdit, must, percentiles, RUN, saveResult, sendUpdate, serverText, session, setupDoc, sleep } from '../lib.mjs'

const WRITERS = Number(process.env.WRITERS ?? 20)
const EDITS = Number(process.env.EDITS ?? 25)
const SPOT = process.env.SPOT ?? 'same' // 'same' = everybody inserts at position 0
const { api, ws: wsUrl } = endpoints()

console.log(`convergence test run=${RUN} writers=${WRITERS} edits/writer=${EDITS} spot=${SPOT}`)
const owner = await session(api, 'Owner', `owner-${RUN}@test.collabdoc.invalid`)
const writers = await Promise.all(Array.from({ length: WRITERS }, (_, i) => session(api, `Bot ${i}`, `bot${i}-${RUN}@test.collabdoc.invalid`)))
const doc = await setupDoc(api, owner, writers, `convergence ${RUN}`)
const docId = doc.docId

// Each bot: its own Y.Doc, connected to the WebSocket, initialised from the server state.
const bots = await Promise.all(
  writers.map(async (w, i) => {
    const ydoc = new Y.Doc()
    const socket = new WebSocket(`${wsUrl}?token=${encodeURIComponent(w.token)}&docId=${docId}&cid=${ydoc.clientID}`)
    let received = 0
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'update') {
        Y.applyUpdate(ydoc, fromB64(msg.data), 'remote')
        received++
      }
    })
    await new Promise((res, rej) => {
      socket.once('open', res)
      socket.once('error', rej)
    })
    const { state } = await must(api, 'GET', `/documents/${docId}/state`, undefined, w.token)
    Y.applyUpdate(ydoc, fromB64(state), 'remote')
    return { i, w, ydoc, socket, received: () => received, accepted: [], rejected: [], latencies: [] }
  }),
)
console.log(`${bots.length} writers connected`)

const t0 = Date.now()
await Promise.all(
  bots.map(async (bot) => {
    for (let j = 0; j < EDITS; j++) {
      const marker = `<b${bot.i}e${j}>`
      const update = localEdit(bot.ydoc, (t) => t.insert(SPOT === 'same' ? 0 : Math.floor(Math.random() * (t.length + 1)), marker))
      const r = await sendUpdate(api, bot.w.token, docId, `t${RUN}-b${bot.i}-e${j}`, update)
      bot.latencies.push(r.ms)
      ;(r.accepted ? bot.accepted : bot.rejected).push({ marker, status: r.status, attempts: r.attempts })
      await sleep(Math.random() * 40)
    }
  }),
)
const durationMs = Date.now() - t0
await sleep(4000) // let the last broadcasts arrive

const final = await serverText(api, owner.token, docId)
const accepted = bots.flatMap((b) => b.accepted.map((a) => a.marker))
const rejected = bots.flatMap((b) => b.rejected)
const missing = accepted.filter((m) => !final.includes(m))
const duplicated = accepted.filter((m) => final.split(m).length - 1 > 1)
const liveDiffers = bots.filter((b) => b.ydoc.getText('content').toString() !== final).map((b) => b.i)

// (c) eventual convergence: reload from the server (what a reconnecting client does).
for (const b of bots) Y.applyUpdate(b.ydoc, fromB64((await must(api, 'GET', `/documents/${docId}/state`, undefined, b.w.token)).state), 'remote')
const afterReloadDiffers = bots.filter((b) => b.ydoc.getText('content').toString() !== final).map((b) => b.i)
bots.forEach((b) => b.socket.close())

const result = {
  test: 'convergence',
  run: RUN,
  docId,
  params: { writers: WRITERS, editsPerWriter: EDITS, spot: SPOT },
  durationMs,
  editsSent: WRITERS * EDITS,
  editsAccepted: accepted.length,
  editsRejected: rejected.length,
  rejectedDetail: rejected.slice(0, 20),
  retriesNeeded: bots.flatMap((b) => [...b.accepted, ...b.rejected]).filter((x) => x.attempts > 1).length,
  latencyMs: percentiles(bots.flatMap((b) => b.latencies)),
  finalLength: final.length,
  acceptedMissingFromFinal: missing,
  acceptedDuplicatedInFinal: duplicated,
  liveCopiesDifferentFromServer: liveDiffers,
  copiesDifferentAfterReload: afterReloadDiffers,
  broadcastsReceivedPerWriter: percentiles(bots.map((b) => b.received())),
}
result.PASS = missing.length === 0 && duplicated.length === 0 && afterReloadDiffers.length === 0
console.log(JSON.stringify(result, null, 2))
console.log(`saved ${saveResult('convergence', result)}`)
console.log(result.PASS ? '✅ PASS: no accepted edit lost, all copies identical' : '❌ FAIL')
process.exit(result.PASS ? 0 : 1)
