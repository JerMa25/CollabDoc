// Detects writers who keep hammering the limits. Each rejected write is a "strike" counted in a
// fixed time window; past a threshold the writer is blocked for a while. Items expire through
// DynamoDB TTL, and the `until` attribute is also checked because TTL deletion is lazy.
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { ABUSE, TABLES, nowSec } from './config'
import { ddb } from './ddb'

export const blockKey = (email: string) => `block#${email}`

/** Returns the epoch second until which the writer is blocked, or null. */
export async function getBlockedUntil(email: string): Promise<number | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLES.abuse, Key: { pk: blockKey(email) } }))
  const until = Number(res.Item?.until ?? 0)
  return until > nowSec() ? until : null
}

/** Records a strike; returns the block end if this strike triggered a block. */
export async function recordStrike(email: string, reason: string): Promise<number | null> {
  const now = nowSec()
  const window = Math.floor(now / ABUSE.windowSec)
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLES.abuse,
      Key: { pk: `strike#${email}#${window}` },
      UpdateExpression: 'ADD strikes :one SET #ttl = :ttl, lastReason = :reason',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':ttl': now + 2 * ABUSE.windowSec, ':reason': reason },
      ReturnValues: 'UPDATED_NEW',
    }),
  )
  const strikes = Number(res.Attributes?.strikes ?? 0)
  if (strikes < ABUSE.threshold) return null
  const until = now + ABUSE.blockSec
  await ddb.send(
    new PutCommand({
      TableName: TABLES.abuse,
      Item: { pk: blockKey(email), email, until, reason, strikes, blockedAt: now, ttl: until + 3600 },
    }),
  )
  console.warn(JSON.stringify({ event: 'writer_blocked', email, reason, strikes, until }))
  return until
}
