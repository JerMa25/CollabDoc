// Writers have no real account (as allowed by the subject): a name + e-mail typed at entry.
// The server signs them into a token (HMAC-SHA256) so that every later request carries an
// identity the client cannot alter without the server secret.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { config, TABLES, nowSec } from './config'
import { ddb } from './ddb'
import { HttpError, type HttpEvent } from './http'
import { getSecret } from './secrets'

export interface Writer {
  name: string
  email: string
}

const TOKEN_TTL_SEC = 7 * 24 * 3600
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const b64url = (s: Buffer | string) => Buffer.from(s).toString('base64url')

export function validateWriter(input: { name?: unknown; email?: unknown }): Writer {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  if (name.length < 1 || name.length > 60) throw new HttpError(400, 'INVALID_NAME', 'Name must be 1-60 characters')
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'INVALID_EMAIL', 'Invalid e-mail address')
  return { name, email }
}

export function signToken(writer: Writer, secret: string, now = nowSec()): string {
  const payload = b64url(JSON.stringify({ n: writer.name, e: writer.email, exp: now + TOKEN_TTL_SEC }))
  const sig = b64url(createHmac('sha256', secret).update(payload).digest())
  return `${payload}.${sig}`
}

export function verifyToken(token: string, secret: string, now = nowSec()): Writer | null {
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const expected = createHmac('sha256', secret).update(payload).digest()
  const given = Buffer.from(sig, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof data.exp !== 'number' || data.exp < now) return null
    return { name: data.n, email: data.e }
  } catch {
    return null
  }
}

export async function writerFromToken(token: string | undefined): Promise<Writer | null> {
  if (!token) return null
  return verifyToken(token, await getSecret(config.sessionSecretParam))
}

/** Extracts the writer from `Authorization: Bearer <token>`, or throws 401. */
export async function requireWriter(event: HttpEvent): Promise<Writer> {
  const header = event.headers?.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : undefined
  const writer = await writerFromToken(token)
  if (!writer) throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid session token')
  return writer
}

export async function isMember(email: string, docId: string): Promise<boolean> {
  const res = await ddb.send(new GetCommand({ TableName: TABLES.members, Key: { email, docId } }))
  return !!res.Item
}

/** Throws 403 unless the writer has access to the document. */
export async function requireMember(writer: Writer, docId: string): Promise<void> {
  if (!(await isMember(writer.email, docId))) throw new HttpError(403, 'FORBIDDEN', 'You do not have access to this document')
}
