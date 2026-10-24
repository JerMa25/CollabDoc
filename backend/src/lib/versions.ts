// Versions are plain-text snapshots of a document stored in S3 (versions/<docId>/<id>.txt),
// with their metadata in the Versions table. Restoring a version does NOT rewrite history: it
// applies a new CRDT update that replaces the current text, so collaborators converge on it
// like on any other edit, and the restore can itself be undone by restoring another version.
import { randomUUID } from 'node:crypto'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { config, TABLES } from './config'
import { ddb, isConditionFailure } from './ddb'
import { broadcast } from './broadcast'
import { getDocument, loadDocState } from './docstate'
import { b64, HttpError } from './http'
import { s3 } from './pdf'
import { replaceTextUpdate, textFromState } from './yjs'

export interface VersionMeta {
  docId: string
  versionId: string
  createdAt: string
  createdBy: string
  label: string
  rev: number
  length: number
  preview: string
}

const newVersionId = () => `v${Date.now()}${Math.random().toString(36).slice(2, 6)}`
const versionKey = (docId: string, versionId: string) => `versions/${docId}/${versionId}.txt`

export async function createVersion(docId: string, createdBy: string, label: string, known?: { state: Uint8Array; rev: number }): Promise<VersionMeta> {
  const rev = known?.rev ?? Number((await getDocument(docId, true)).rev ?? 0)
  const state = known?.state ?? (await loadDocState(docId)).state
  const text = textFromState(state)
  const versionId = newVersionId()
  await s3.send(new PutObjectCommand({ Bucket: config.dataBucket, Key: versionKey(docId, versionId), Body: text, ContentType: 'text/plain; charset=utf-8' }))
  const meta: VersionMeta = { docId, versionId, createdAt: new Date().toISOString(), createdBy, label, rev, length: text.length, preview: text.slice(0, 160) }
  await ddb.send(new PutCommand({ TableName: TABLES.versions, Item: meta }))
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLES.documents,
        Key: { docId },
        UpdateExpression: 'SET versionRev = :rev',
        ConditionExpression: 'attribute_not_exists(versionRev) OR versionRev < :rev',
        ExpressionAttributeValues: { ':rev': rev },
      }),
    )
  } catch (e) {
    if (!isConditionFailure(e)) throw e
  }
  return meta
}

export async function listVersions(docId: string): Promise<VersionMeta[]> {
  const res = await ddb.send(
    new QueryCommand({ TableName: TABLES.versions, KeyConditionExpression: 'docId = :d', ExpressionAttributeValues: { ':d': docId }, ScanIndexForward: false, Limit: 100 }),
  )
  return (res.Items ?? []) as VersionMeta[]
}

export async function getVersionText(docId: string, versionId: string): Promise<string> {
  if (!/^v\d{13}[a-z0-9]{0,4}$/.test(versionId)) throw new HttpError(400, 'INVALID_VERSION', 'Invalid version id')
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: config.dataBucket, Key: versionKey(docId, versionId) }))
    return await res.Body!.transformToString('utf-8')
  } catch (e: any) {
    if (e?.name === 'NoSuchKey') throw new HttpError(404, 'VERSION_NOT_FOUND', 'Version not found')
    throw e
  }
}

export async function restoreVersion(docId: string, versionId: string, by: { name: string; email: string }): Promise<{ backup: VersionMeta }> {
  const target = await getVersionText(docId, versionId)
  const rev = Number((await getDocument(docId, true)).rev ?? 0)
  const { state } = await loadDocState(docId)
  // Keep the current text as a version first, so a restore never loses anything.
  const backup = await createVersion(docId, by.email, `Sauvegarde avant restauration de ${versionId}`, { state, rev })
  const update = replaceTextUpdate(state, target)
  // Same order as a normal edit: store, then bump the revision (see handlers/update.ts).
  await ddb.send(new PutCommand({ TableName: TABLES.updates, Item: { docId, updateId: `restore-${randomUUID()}`, data: update, email: by.email, chars: 0, kind: 'restore', createdAt: new Date().toISOString() } }))
  await ddb.send(new UpdateCommand({ TableName: TABLES.documents, Key: { docId }, UpdateExpression: 'ADD rev :one SET updatedAt = :now', ExpressionAttributeValues: { ':one': 1, ':now': new Date().toISOString() } }))
  await broadcast(docId, { type: 'update', data: b64(update), by: by.name })
  return { backup }
}
