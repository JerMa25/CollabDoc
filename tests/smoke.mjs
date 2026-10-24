// Quick end-to-end check of every feature against the deployed stack. Usage: FRONT_URL=https://xxx.cloudfront.net node smoke.mjs
import * as Y from 'yjs'
import { must, call, localEdit, sendUpdate, serverText, session } from './lib.mjs'
import { endpoints } from './lib.mjs'
const { api } = endpoints(); const front = process.env.FRONT_URL
const s = await session(api, 'Smoke', 'smoke@test.collabdoc.invalid')
const doc = await must(api, 'POST', '/documents', { title: 'Smoke test' }, s.token)
const y = new Y.Doc()
const r = await sendUpdate(api, s.token, doc.docId, 'smoke-1', localEdit(y, t => t.insert(0, 'Bonjour à tous, première version.')))
console.log('update', r.status, r.data?.chars, r.data?.credit?.remaining, Math.round(r.ms)+'ms')
const dup = await sendUpdate(api, s.token, doc.docId, 'smoke-1', localEdit(new Y.Doc(), t => t.insert(0, 'x')))
console.log('duplicate id ->', dup.status, dup.data?.duplicate)
console.log('text:', JSON.stringify(await serverText(api, s.token, doc.docId)))
const v = await must(api, 'POST', `/documents/${doc.docId}/versions`, {}, s.token); console.log('version', v.versionId)
const link = await must(api, 'POST', `/documents/${doc.docId}/links`, { maxDownloads: 2 }, s.token)
for (let i = 0; i < 3; i++) { const c = await call(api, 'POST', `/links/${link.linkId}/claim`); console.log('claim', c.status, c.data.status, c.data.copyNumber ?? '', Math.round(c.ms)+'ms') ; if (c.status===200 && i===0) { const pdf = await fetch(c.data.url); console.log('  pdf', pdf.status, pdf.headers.get('content-type'), (await pdf.arrayBuffer()).byteLength, 'bytes') } }
const pub = await fetch(`${front}/public/links/${link.linkId}`); console.log('cloudfront status', pub.status, JSON.stringify(await pub.json()), pub.headers.get('x-cache'))
console.log('vers list', (await must(api,'GET',`/documents/${doc.docId}/versions`,undefined,s.token)).versions.length)
console.log('restore', (await call(api,'POST',`/documents/${doc.docId}/versions/${v.versionId}/restore`,{},s.token)).status)
