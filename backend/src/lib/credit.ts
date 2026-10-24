// Daily write credit. One DynamoDB item per (writer, UTC day): `<email>#<YYYY-MM-DD>`.
// Debiting happens inside the same DynamoDB transaction that stores the edit (see
// handlers/update.ts), guarded by a condition: the counter can never exceed the limit, even
// when the same writer sends edits from several devices at the same instant.
import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { CREDIT_LIMIT, TABLES } from './config'
import { ddb } from './ddb'

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10)
export const creditKey = (email: string, d = new Date()) => `${email}#${utcDay(d)}`

/** Next recharge: midnight UTC. */
export function nextReset(d = new Date()): string {
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1))
  return next.toISOString()
}

/** TTL so that old credit items disappear by themselves (2 days later). */
export const creditTtl = (d = new Date()) => Math.floor(d.getTime() / 1000) + 2 * 24 * 3600

export interface Credit {
  used: number
  limit: number
  remaining: number
  resetsAt: string
}

export async function getCredit(email: string): Promise<Credit> {
  const res = await ddb.send(new GetCommand({ TableName: TABLES.credits, Key: { pk: creditKey(email) }, ConsistentRead: true }))
  const used = Number(res.Item?.used ?? 0)
  return { used, limit: CREDIT_LIMIT, remaining: Math.max(0, CREDIT_LIMIT - used), resetsAt: nextReset() }
}
