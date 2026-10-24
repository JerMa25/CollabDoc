// POST /documents/{docId}/updates  — submit an edit (a binary Yjs update, base64).
//
// Constraint 2 (no accepted edit is lost, everyone converges):
//   an edit is "accepted" only once it is durably stored in DynamoDB; only then is it
//   acknowledged (HTTP 200) and broadcast. Yjs updates commute, so every participant that
//   applies the same set of updates — in any order — ends up with the same text.
//   The client-chosen `id` makes the call idempotent: a retry after a network failure is
//   stored once and charged once.
// Constraint 4 (never more than the daily credit, even from several devices):
//   the credit debit and the storage of the edit happen in ONE DynamoDB transaction whose
//   condition is `used + chars <= limit`. Two concurrent devices cannot both pass it.
import { TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { getBlockedUntil, recordStrike } from '../lib/abuse'
import { requireMember, requireWriter } from '../lib/auth'
import { broadcast } from '../lib/broadcast'
import { CREDIT_LIMIT, TABLES } from '../lib/config'
import { creditKey, creditTtl, getCredit } from '../lib/credit'
import { ddb } from '../lib/ddb'
import { fromB64, HttpError, json, parseBody, pathParam, wrap } from '../lib/http'
import { countInsertedChars } from '../lib/yjs'

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/
const MAX_UPDATE_BYTES = 256 * 1024

const blockedError = (until: number) =>
  new HttpError(423, 'WRITER_BLOCKED', 'Too many rejected writes: you are temporarily blocked', { blockedUntil: new Date(until * 1000).toISOString() })

async function rejectCredit(email: string, chars: number): Promise<never> {
  const until = await recordStrike(email, 'credit_exhausted')
  if (until) throw blockedError(until)
  throw new HttpError(403, 'CREDIT_EXHAUSTED', 'Daily write credit exhausted', { chars, credit: await getCredit(email) })
}

export const handler = wrap(async (event) => {
  const writer = await requireWriter(event)
  const docId = pathParam(event, 'docId')
  const body = parseBody<{ id?: string; update?: string }>(event)
  if (!body.id || !ID_RE.test(body.id)) throw new HttpError(400, 'INVALID_ID', 'id must match [A-Za-z0-9_-]{1,80}')
  if (typeof body.update !== 'string' || body.update.length === 0) throw new HttpError(400, 'INVALID_UPDATE', 'update (base64) is required')

  const [blockedUntil] = await Promise.all([getBlockedUntil(writer.email), requireMember(writer, docId)])
  if (blockedUntil) {
    await recordStrike(writer.email, 'write_while_blocked')
    throw blockedError(blockedUntil)
  }

  const update = fromB64(body.update)
  if (update.byteLength > MAX_UPDATE_BYTES) throw new HttpError(413, 'UPDATE_TOO_LARGE', 'Update too large')
  const chars = countInsertedChars(update)
  if (chars > CREDIT_LIMIT) return rejectCredit(writer.email, chars)

  const now = new Date()
  const transactItems: any[] = [
    {
      Put: {
        TableName: TABLES.updates,
        Item: { docId, updateId: body.id, data: update, email: writer.email, chars, createdAt: now.toISOString() },
        ConditionExpression: 'attribute_not_exists(updateId)', // idempotency
      },
    },
  ]
  if (chars > 0) {
    transactItems.push({
      Update: {
        TableName: TABLES.credits,
        Key: { pk: creditKey(writer.email, now) },
        UpdateExpression: 'SET used = if_not_exists(used, :zero) + :chars, email = :email, #ttl = :ttl',
        ConditionExpression: 'attribute_not_exists(used) OR used <= :maxBefore',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':zero': 0, ':chars': chars, ':maxBefore': CREDIT_LIMIT - chars, ':email': writer.email, ':ttl': creditTtl(now) },
      },
    })
  }

  let duplicate = false
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }))
  } catch (e: any) {
    if (e?.name !== 'TransactionCanceledException') throw e
    const reasons: { Code?: string }[] = e.CancellationReasons ?? []
    if (reasons[0]?.Code === 'ConditionalCheckFailed') {
      duplicate = true // already accepted earlier (client retry): acknowledge again, charge nothing
    } else if (reasons[1]?.Code === 'ConditionalCheckFailed') {
      return rejectCredit(writer.email, chars)
    } else if (reasons.some((r) => r.Code === 'TransactionConflict')) {
      throw new HttpError(503, 'RETRY', 'Concurrent write conflict, retry with the same id')
    } else {
      throw e
    }
  }

  // Bump the document revision AFTER the edit is stored and BEFORE it is acknowledged.
  // A download that starts after the ack therefore sees a revision whose PDF is rendered from
  // a read made after this edit was stored (constraint 3). It is a plain atomic update, not
  // part of the transaction: concurrent writers of the same document would otherwise make
  // their transactions conflict on this single item.
  await ddb.send(
    new UpdateCommand({
      TableName: TABLES.documents,
      Key: { docId },
      UpdateExpression: 'ADD rev :one SET updatedAt = :now',
      ExpressionAttributeValues: { ':one': 1, ':now': now.toISOString() },
    }),
  )

  // Duplicates are broadcast again too: harmless (applying an update twice is a no-op) and it
  // covers the case where the first attempt was stored but its broadcast did not complete.
  const [credit] = await Promise.all([getCredit(writer.email), broadcast(docId, { type: 'update', data: body.update, id: body.id })])
  return json(200, { accepted: true, duplicate, chars: duplicate ? 0 : chars, credit })
})
