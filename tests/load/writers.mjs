// Background load for the peak test (constraint 5): WRITERS writers keep typing during
// DURATION seconds, spread over DOCS documents (several writers per document), each sending a
// small edit every ~1-2 s like a human typing, and receiving the others' edits by WebSocket.
// At the end it checks, per document, that every accepted edit is present (constraint 2 under load).
//
// Usage: WRITERS=300 DOCS=30 DURATION=300 node load/writers.mjs
import WebSocket from 'ws'
import * as Y from 'yjs'
import { endpoints, fromB64, localEdit, must, percentiles, RUN, saveResult, sendUpdate, serverText, session, setupDoc, sleep } from '../lib.mjs'

const WRITERS = Number(process.env.WRITERS ?? 300)
const DOCS = Number(process.env.DOCS ?? 30)
const DURATION = Number(process.env.DURATION ?? 300)
const { api, ws: wsUrl } = endpoints()

console.log(`writers load run=${RUN} writers=${WRITERS} docs=${DOCS} duration=${DURATION}s`)
const owner = await session(api, 'Owner', `wowner-${RUN}@test.collabdoc.invalid`)
const writers = []
for (let i = 0; i < WRITERS; i += 25) {
  writers.push(...(await Promise.all(Array.from({ length: Math.min(25, WRITERS - i) }, (_, k) => session(api, `W${i + k}`, `w${i + k}-${RUN}@test.collabdoc.invalid`)))))
}
const docs = []
for (let d = 0; d < DOCS; d++) {
  const members = writers.filter((_, i) => i % DOCS === d)
  docs.push({ ...(await setupDoc(api, owner, members, `load ${RUN} #${d}`)), members })
}
console.log('setup done, starting to write')

const latencies = []
const statuses = {}
const acceptedByDoc = new Map(docs.map((d) => [d.docId, []]))
const end = Date.now() + DURATION * 1000

await Promise.all(
  writers.map(async (w, i) => {
    const doc = docs[i % DOCS]
    const ydoc = new Y.Doc()
    await sleep(Math.random() * 5000) // writers do not all start at the same millisecond
    const socket = new WebSocket(`${wsUrl}?token=${encodeURIComponent(w.token)}&docId=${doc.docId}&cid=${ydoc.clientID}`)
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'update') Y.applyUpdate(ydoc, fromB64(msg.data), 'remote')
    })
    socket.on('error', () => {})
    const { state } = await must(api, 'GET', `/documents/${doc.docId}/state`, undefined, w.token)
    Y.applyUpdate(ydoc, fromB64(state), 'remote')
    for (let j = 0; Date.now() < end; j++) {
      const marker = `[w${i}.${j}]`
      const update = localEdit(ydoc, (t) => t.insert(Math.floor(Math.random() * (t.length + 1)), marker))
      const r = await sendUpdate(api, w.token, doc.docId, `l${RUN}-w${i}-${j}`, update)
      latencies.push(r.ms)
      statuses[r.status] = (statuses[r.status] ?? 0) + 1
      if (r.accepted) acceptedByDoc.get(doc.docId).push(marker)
      await sleep(1000 + Math.random() * 1000)
    }
    socket.close()
  }),
)

let missing = 0
for (const d of docs) {
  const text = await serverText(api, owner.token, d.docId)
  missing += acceptedByDoc.get(d.docId).filter((m) => !text.includes(m)).length
}
const result = {
  test: 'writers-load',
  run: RUN,
  params: { writers: WRITERS, docs: DOCS, durationSec: DURATION },
  editsSent: latencies.length,
  statuses,
  latencyMs: percentiles(latencies),
  acceptedMissing: missing,
}
result.PASS = missing === 0
console.log(JSON.stringify(result, null, 2))
console.log(`saved ${saveResult('writers', result)}`)
