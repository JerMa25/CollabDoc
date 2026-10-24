// A document's content is the CRDT merge of every accepted update stored in the Updates table.
// Reading with ConsistentRead guarantees that every update acknowledged before this call is
// included: a download at T1 contains everything accepted before T1.
import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { TABLES } from './config'
import { ddb, queryAll } from './ddb'
import { HttpError } from './http'
import { mergeUpdates } from './yjs'

export interface DocumentMeta {
  docId: string
  title: string
  ownerEmail: string
  ownerName: string
  createdAt: string
  rev: number
  versionRev?: number
  updatedAt?: string
}

export async function getDocument(docId: string, consistent = false): Promise<DocumentMeta> {
  const res = await ddb.send(new GetCommand({ TableName: TABLES.documents, Key: { docId }, ConsistentRead: consistent }))
  if (!res.Item) throw new HttpError(404, 'DOCUMENT_NOT_FOUND', 'Document not found')
  return res.Item as DocumentMeta
}

export async function loadDocState(docId: string): Promise<{ state: Uint8Array; updates: number }> {
  const items = await queryAll({
    TableName: TABLES.updates,
    KeyConditionExpression: 'docId = :d',
    ExpressionAttributeValues: { ':d': docId },
    ProjectionExpression: '#data',
    ExpressionAttributeNames: { '#data': 'data' },
    ConsistentRead: true,
  })
  const updates = items.map((i) => i.data as Uint8Array)
  return { state: mergeUpdates(updates), updates: updates.length }
}
