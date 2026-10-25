// Writers' REST API: session, documents, sharing, initial state, versions, download links.
// (Edits go through handlers/update.ts, downloads through handlers/claim.ts: they have
// different permissions and scaling needs, so they are separate functions.)
import { randomBytes } from 'node:crypto'
import { PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { requireMember, requireWriter, signToken, validateWriter } from '../lib/auth'
import { getBlockedUntil } from '../lib/abuse'
import { config, TABLES } from '../lib/config'
import { getCredit } from '../lib/credit'
import { ddb, queryAll } from '../lib/ddb'
import { getDocument, loadDocState } from '../lib/docstate'
import { b64, fromB64, HttpError, json, parseBody, pathParam, wrap, type HttpEvent, type HttpResult } from '../lib/http'
import { diffFromStateVector } from '../lib/yjs'
import { getSecret } from '../lib/secrets'
import { createVersion, getVersionText, listVersions, restoreVersion } from '../lib/versions'

const newId = (bytes: number) => randomBytes(bytes).toString('base64url')
const MAX_LINK_DOWNLOADS = 100_000

type Route = (event: HttpEvent) => Promise<HttpResult>

const routes: Record<string, Route> = {
  // --- session -------------------------------------------------------------
  'POST /session': async (event) => {
    const writer = validateWriter(parseBody(event))
    const token = signToken(writer, await getSecret(config.sessionSecretParam))
    return json(200, { token, ...writer })
  },

  'GET /me': async (event) => {
    const writer = await requireWriter(event)
    const [credit, blockedUntil] = await Promise.all([getCredit(writer.email), getBlockedUntil(writer.email)])
    return json(200, { ...writer, credit, blockedUntil: blockedUntil ? new Date(blockedUntil * 1000).toISOString() : null })
  },

  // --- documents -------------------------------------------------------------
  'GET /documents': async (event) => {
    const writer = await requireWriter(event)
    const items = await queryAll({ TableName: TABLES.members, KeyConditionExpression: 'email = :e', ExpressionAttributeValues: { ':e': writer.email } })
    const documents = items
      .map((i) => ({ docId: i.docId, title: i.title, role: i.role, addedAt: i.addedAt }))
      .sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)))
    return json(200, { documents })
  },

  'POST /documents': async (event) => {
    const writer = await requireWriter(event)
    const title = String(parseBody(event).title ?? '').trim()
    if (title.length < 1 || title.length > 120) throw new HttpError(400, 'INVALID_TITLE', 'Title must be 1-120 characters')
    const docId = newId(9)
    const now = new Date().toISOString()
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: TABLES.documents, Item: { docId, title, ownerEmail: writer.email, ownerName: writer.name, createdAt: now, updatedAt: now, rev: 0 }, ConditionExpression: 'attribute_not_exists(docId)' } },
          { Put: { TableName: TABLES.members, Item: { email: writer.email, docId, title, role: 'owner', addedBy: writer.email, addedAt: now } } },
        ],
      }),
    )
    return json(201, { docId, title, ownerEmail: writer.email, createdAt: now })
  },

  'GET /documents/{docId}': async (event) => {
    const writer = await requireWriter(event)
    const docId = pathParam(event, 'docId')
    await requireMember(writer, docId)
    const [doc, members] = await Promise.all([
      getDocument(docId),
      queryAll({ TableName: TABLES.members, IndexName: 'byDoc', KeyConditionExpression: 'docId = :d', ExpressionAttributeValues: { ':d': docId } }),
    ])
    return json(200, { ...doc, members: members.map((m) => ({ email: m.email, role: m.role, addedAt: m.addedAt })) })
  },

  'POST /documents/{docId}/members': async (event) => {
    const writer = await requireWriter(event)
    const docId = pathParam(event, 'docId')
    await requireMember(writer, docId)
    const { email } = validateWriter({ name: 'member', email: parseBody(event).email })
    const doc = await getDocument(docId)
    await ddb.send(
      new PutCommand({
        TableName: TABLES.members,
        Item: { email, docId, title: doc.title, role: 'editor', addedBy: writer.email, addedAt: new Date().toISOString() },
        ConditionExpression: 'attribute_not_exists(email)',
      }),
    ).catch((e) => {
      if (e?.name !== 'ConditionalCheckFailedException') throw e // already a member: idempotent
    })
    return json(200, { docId, email, role: 'editor' })
  },

  /** Full current state (merged Yjs update, base64). The client applies it, then follows the WebSocket. */
  'GET /documents/{docId}/state': async (event) => {
    const writer = await requireWriter(event)
    const docId = pathParam(event, 'docId')
    await requireMember(writer, docId)
    const doc = await getDocument(docId, true)
    const { state, updates } = await loadDocState(docId)
    // With ?sv=<client state vector, base64>, only what the client is missing is returned.
    const sv = event.queryStringParameters?.sv
    const body = sv ? diffFromStateVector(state, fromB64(sv)) : state
    return json(200, { docId, rev: doc.rev ?? 0, updates, state: b64(body), diff: !!sv })
  },

  // --- versions --------------------------------------------------------------
  'GET /documents/{docId}/versions': async (event) => {
    const writer = await requireWriter(event)
    const docId = pathParam(event, 'docId')
    await requireMember(writer, docId)
    return json(200, { versions: await listVersions(docId) })
  },

  'POST /documents/{docId}/versions': async (event) => {
    const writer = await requireWriter(event)
    const docId = pathParam(event, 'docId')
    await requireMember(writer, docId)
    const label = String(parseBody(event).label ?? '').trim().slice(0, 120) || `Version de ${writer.name}`
    return json(201, await createVersion(docId, writer.email, label))
  },

  'GET /documents/{docId}/versions/{versionId}': async (event) => {
    const writer = await requireWriter(event)
    const docId = pathParam(event, 'docId')
    await requireMember(writer, docId)
    const versionId = pathParam(event, 'versionId')
    return json(200, { docId, versionId, text: await getVersionText(docId, versionId) })
  },

  'POST /documents/{docId}/versions/{versionId}/restore': async (event) => {
    const writer = await requireWriter(event)
    const docId = pathParam(event, 'docId')
    await requireMember(writer, docId)
    const versionId = pathParam(event, 'versionId')
    const { backup } = await restoreVersion(docId, versionId, writer)
    return json(200, { restored: versionId, backupVersionId: backup.versionId })
  },

  // --- download links --------------------------------------------------------
  'POST /documents/{docId}/links': async (event) => {
    const writer = await requireWriter(event)
    const docId = pathParam(event, 'docId')
    await requireMember(writer, docId)
    const max = Number(parseBody(event).maxDownloads)
    if (!Number.isInteger(max) || max < 1 || max > MAX_LINK_DOWNLOADS) {
      throw new HttpError(400, 'INVALID_MAX_DOWNLOADS', `maxDownloads must be an integer between 1 and ${MAX_LINK_DOWNLOADS}`)
    }
    const doc = await getDocument(docId)
    const link = {
      linkId: newId(8),
      docId,
      docTitle: doc.title,
      creatorEmail: writer.email,
      creatorName: writer.name,
      maxDownloads: max,
      remaining: max,
      createdAt: new Date().toISOString(),
    }
    await ddb.send(new PutCommand({ TableName: TABLES.links, Item: link, ConditionExpression: 'attribute_not_exists(linkId)' }))
    return json(201, { ...link, url: config.frontendUrl ? `${config.frontendUrl}/#/d/${link.linkId}` : undefined })
  },

  'GET /documents/{docId}/links': async (event) => {
    const writer = await requireWriter(event)
    const docId = pathParam(event, 'docId')
    await requireMember(writer, docId)
    const links = await queryAll({ TableName: TABLES.links, IndexName: 'byDoc', KeyConditionExpression: 'docId = :d', ExpressionAttributeValues: { ':d': docId } })
    return json(200, { links: links.map((l) => ({ ...l, url: config.frontendUrl ? `${config.frontendUrl}/#/d/${l.linkId}` : undefined })) })
  },
}

export const handler = wrap(async (event) => {
  const route = routes[event.routeKey]
  if (!route) throw new HttpError(404, 'NOT_FOUND', `No route ${event.routeKey}`)
  return route(event)
})
