import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'

export type HttpEvent = APIGatewayProxyEventV2
export type HttpResult = APIGatewayProxyStructuredResultV2

/** An error that maps directly to an HTTP response ({ error: code, message }). */
export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public extra: Record<string, unknown> = {}) {
    super(message ?? code)
  }
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResult {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
    body: JSON.stringify(body),
  }
}

export function parseBody<T = any>(event: HttpEvent): T {
  if (!event.body) return {} as T
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be JSON')
  }
}

export function pathParam(event: HttpEvent, name: string): string {
  const value = event.pathParameters?.[name]
  if (!value) throw new HttpError(400, 'MISSING_PARAMETER', `Missing path parameter ${name}`)
  return value
}

/** Wraps a handler: HttpError -> clean JSON response, anything else -> logged 500. */
export function wrap(fn: (event: HttpEvent) => Promise<HttpResult>) {
  return async (event: HttpEvent): Promise<HttpResult> => {
    try {
      return await fn(event)
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.code, message: e.message, ...e.extra })
      console.error('Unhandled error', e)
      return json(500, { error: 'INTERNAL', message: 'Internal error' })
    }
  }
}

export const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64')
export const fromB64 = (data: string) => new Uint8Array(Buffer.from(data, 'base64'))
