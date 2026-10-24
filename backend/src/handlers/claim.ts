// Public download endpoints (no identity required).
//
//   GET  /links/{linkId}              link status (also served through CloudFront at
//   GET  /public/links/{linkId}       /public/... with a 2 s cache, for visitors who poll)
//   POST /links/{linkId}/claim        take one copy -> presigned S3 URL of the current PDF
//
// Constraint 1 (never one download too many): one copy is taken by a single atomic
// conditional DynamoDB update `remaining = remaining - 1 IF remaining > 0`. DynamoDB applies
// conditional writes on an item one after the other, so with N copies exactly N calls can
// succeed, however many visitors click at the same instant.
// Constraint 3 (document as it is at T1): the PDF is built from the current state when the
// copy is taken, not when the link was created (see lib/pdf.ts).
// Constraints 5 & 6: every visitor gets an explicit status: 200 ok / 410 exhausted /
// 429 or 503 "wait and retry" (API Gateway throttling also answers 429 during the peak).
// Once a link is exhausted, this container remembers it and answers 410 without touching
// DynamoDB or S3 (the count never goes back up, except for the refund below).
import { randomUUID } from 'node:crypto'
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { TABLES } from '../lib/config'
import { ddb, isConditionFailure } from '../lib/ddb'
import { HttpError, json, pathParam, wrap, type HttpResult } from '../lib/http'
import { ensureCurrentPdf, presignPdf } from '../lib/pdf'
import { PDF_URL_TTL_SEC } from '../lib/config'

const exhaustedHere = new Set<string>()
const LINK_RE = /^[A-Za-z0-9_-]{6,20}$/

const exhausted = (linkId: string, extra: object = {}): HttpResult => {
  exhaustedHere.add(linkId)
  return json(410, { status: 'exhausted', linkId, remaining: 0, message: 'Ce lien a atteint son nombre maximal de téléchargements.', ...extra })
}

async function getLink(linkId: string) {
  if (!LINK_RE.test(linkId)) throw new HttpError(404, 'LINK_NOT_FOUND', 'Unknown link', { status: 'not_found' })
  const res = await ddb.send(new GetCommand({ TableName: TABLES.links, Key: { linkId } }))
  if (!res.Item) throw new HttpError(404, 'LINK_NOT_FOUND', 'Unknown link', { status: 'not_found' })
  return res.Item
}

async function status(linkId: string, cacheSeconds: number): Promise<HttpResult> {
  const link = await getLink(linkId)
  const remaining = Math.max(0, Number(link.remaining))
  return json(
    200,
    { linkId, docTitle: link.docTitle, maxDownloads: link.maxDownloads, remaining, status: remaining > 0 ? 'available' : 'exhausted' },
    { 'cache-control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store' },
  )
}

async function claim(linkId: string): Promise<HttpResult> {
  if (exhaustedHere.has(linkId)) return exhausted(linkId)

  // Cheap pre-check (eventually consistent read) avoids a write once the link is exhausted.
  const link = await getLink(linkId)
  if (Number(link.remaining) <= 0) return exhausted(linkId)

  // The atomic, authoritative step.
  let remainingAfter: number
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: TABLES.links,
        Key: { linkId },
        UpdateExpression: 'SET remaining = remaining - :one, lastClaimAt = :now',
        ConditionExpression: 'remaining > :zero',
        ExpressionAttributeValues: { ':one': 1, ':zero': 0, ':now': new Date().toISOString() },
        ReturnValues: 'UPDATED_NEW',
      }),
    )
    remainingAfter = Number(res.Attributes?.remaining)
  } catch (e) {
    if (isConditionFailure(e)) return exhausted(linkId)
    throw e
  }
  const copyNumber = Number(link.maxDownloads) - remainingAfter
  const claimId = `${String(copyNumber).padStart(6, '0')}-${randomUUID()}`

  try {
    const { key, title, rev } = await ensureCurrentPdf(link.docId)
    const url = await presignPdf(key, title)
    // Audit trail: one item per copy handed out (used as proof in the test report).
    await ddb.send(new PutCommand({ TableName: TABLES.claims, Item: { linkId, claimId, copyNumber, rev, at: new Date().toISOString() } }))
    console.log(JSON.stringify({ event: 'claim_ok', linkId, copyNumber, remaining: remainingAfter, rev }))
    return json(200, { status: 'ok', linkId, url, expiresIn: PDF_URL_TTL_SEC, copyNumber, remaining: remainingAfter, rev })
  } catch (e) {
    // The copy was reserved but could not be delivered: give it back, ask the visitor to retry.
    console.error('claim delivery failed, refunding', linkId, e)
    await ddb.send(new UpdateCommand({ TableName: TABLES.links, Key: { linkId }, UpdateExpression: 'SET remaining = remaining + :one', ExpressionAttributeValues: { ':one': 1 } }))
    exhaustedHere.delete(linkId)
    return json(503, { status: 'retry', retryAfter: 2, message: 'Service momentanément indisponible, nouvel essai automatique.' }, { 'retry-after': '2' })
  }
}

export const handler = wrap(async (event) => {
  const linkId = pathParam(event, 'linkId')
  switch (event.routeKey) {
    case 'POST /links/{linkId}/claim':
      return claim(linkId)
    case 'GET /links/{linkId}':
      return status(linkId, 0)
    case 'GET /public/links/{linkId}':
      return exhaustedHere.has(linkId) ? exhausted(linkId) : status(linkId, 2)
    default:
      throw new HttpError(404, 'NOT_FOUND', `No route ${event.routeKey}`)
  }
})
