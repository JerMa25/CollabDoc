// Constraint 4 + abuse detection.
// One writer, DEVICES "devices" sending edits in parallel until refused. The total accepted
// must never exceed 10 000 characters. Then the writer keeps hammering: it must get blocked.
//
// Usage: DEVICES=8 node load/credit-multidevice.mjs
import * as Y from 'yjs'
import { endpoints, localEdit, must, RUN, saveResult, sendUpdate, session, setupDoc } from '../lib.mjs'

const DEVICES = Number(process.env.DEVICES ?? 8)
const CHUNK = 400 // characters per edit
const { api } = endpoints()

const email = `credit-${RUN}@test.collabdoc.invalid`
// Several sessions with the same e-mail = several devices of the same person.
const devices = await Promise.all(Array.from({ length: DEVICES }, (_, i) => session(api, `Device ${i}`, email)))
const doc = await setupDoc(api, devices[0], [], `credit ${RUN}`)
console.log(`credit test run=${RUN} devices=${DEVICES} chunk=${CHUNK}`)

let accepted = 0
let firstRefusal = null
const statuses = {}
await Promise.all(
  devices.map(async (d, i) => {
    const ydoc = new Y.Doc()
    for (let j = 0; ; j++) {
      const update = localEdit(ydoc, (t) => t.insert(0, String(i % 10).repeat(CHUNK)))
      const r = await sendUpdate(api, d.token, doc.docId, `c${RUN}-d${i}-${j}`, update)
      statuses[r.status] = (statuses[r.status] ?? 0) + 1
      if (r.accepted) accepted += CHUNK
      else {
        firstRefusal ??= r.data
        break
      }
    }
  }),
)
const me = await must(api, 'GET', '/me', undefined, devices[0].token)

// Hammer: keep trying after refusal -> must end up blocked (423).
let blockedAfter = null
const ydoc = new Y.Doc()
for (let k = 1; k <= 40; k++) {
  const r = await sendUpdate(api, devices[0].token, doc.docId, `h${RUN}-${k}`, localEdit(ydoc, (t) => t.insert(0, 'x')))
  if (r.status === 423) {
    blockedAfter = k
    break
  }
}

const result = {
  test: 'credit-multidevice',
  run: RUN,
  params: { devices: DEVICES, charsPerEdit: CHUNK, limit: 10000 },
  acceptedChars: accepted,
  serverCreditUsed: me.credit.used,
  statuses,
  firstRefusal,
  blockedAfterExtraAttempts: blockedAfter,
}
result.PASS = accepted <= 10000 && me.credit.used <= 10000 && blockedAfter !== null
console.log(JSON.stringify(result, null, 2))
console.log(`saved ${saveResult('credit', result)}`)
console.log(result.PASS ? '✅ PASS: credit never exceeded, abuser blocked' : '❌ FAIL')
process.exit(result.PASS ? 0 : 1)
