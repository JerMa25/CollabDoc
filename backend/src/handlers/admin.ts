// GET /admin/state — the association's view of the application (header `x-admin-token`).
// Open documents (with who is connected), active links with remaining downloads, blocked writers.
import { timingSafeEqual } from 'node:crypto'
import { BatchGetCommand } from '@aws-sdk/lib-dynamodb'
import { config, TABLES, nowSec } from '../lib/config'
import { ddb, scanAll } from '../lib/ddb'
import { HttpError, json, wrap } from '../lib/http'
import { getSecret } from '../lib/secrets'

async function requireAdmin(given: string | undefined) {
  const expected = Buffer.from(await getSecret(config.adminTokenParam))
  const actual = Buffer.from(given ?? '')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HttpError(401, 'UNAUTHORIZED', 'Invalid admin token')
}

async function titles(docIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (let i = 0; i < docIds.length; i += 100) {
    const keys = docIds.slice(i, i + 100).map((docId) => ({ docId }))
    const res = await ddb.send(new BatchGetCommand({ RequestItems: { [TABLES.documents]: { Keys: keys, ProjectionExpression: 'docId, title' } } }))
    for (const d of res.Responses?.[TABLES.documents] ?? []) out[d.docId] = d.title
  }
  return out
}

export const handler = wrap(async (event) => {
  await requireAdmin(event.headers?.['x-admin-token'])
  const now = nowSec()

  const [connections, links, blocks] = await Promise.all([
    scanAll({ TableName: TABLES.connections }),
    scanAll({ TableName: TABLES.links }),
    scanAll({ TableName: TABLES.abuse, FilterExpression: 'begins_with(pk, :b) AND #until > :now', ExpressionAttributeNames: { '#until': 'until' }, ExpressionAttributeValues: { ':b': 'block#', ':now': now } }),
  ])

  const live = connections.filter((c) => Number(c.ttl ?? 0) > now)
  const byDoc = new Map<string, { name: string; email: string; connectedAt: string }[]>()
  for (const c of live) {
    const users = byDoc.get(c.docId) ?? []
    users.push({ name: c.name, email: c.email, connectedAt: c.connectedAt })
    byDoc.set(c.docId, users)
  }
  const docTitles = await titles([...byDoc.keys()])

  return json(200, {
    generatedAt: new Date().toISOString(),
    openDocuments: [...byDoc.entries()].map(([docId, users]) => ({ docId, title: docTitles[docId] ?? '?', connections: users.length, users })),
    activeLinks: links
      .filter((l) => Number(l.remaining) > 0)
      .map((l) => ({ linkId: l.linkId, docId: l.docId, docTitle: l.docTitle, creatorEmail: l.creatorEmail, maxDownloads: l.maxDownloads, remaining: l.remaining, createdAt: l.createdAt })),
    exhaustedLinks: links.filter((l) => Number(l.remaining) <= 0).map((l) => ({ linkId: l.linkId, docTitle: l.docTitle, maxDownloads: l.maxDownloads })),
    blockedWriters: blocks.map((b) => ({ email: b.email, reason: b.reason, strikes: b.strikes, blockedUntil: new Date(Number(b.until) * 1000).toISOString() })),
  })
})
