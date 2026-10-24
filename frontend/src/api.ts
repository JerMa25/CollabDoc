// Small client for the CollabDoc HTTP API (see docs/api.md).

declare global {
  interface Window {
    COLLABDOC_CONFIG: { apiUrl: string; wsUrl: string }
  }
}

export const cfg = window.COLLABDOC_CONFIG

export interface Session {
  token: string
  name: string
  email: string
}

export interface Credit {
  used: number
  limit: number
  remaining: number
  resetsAt: string
}

const SESSION_KEY = 'collabdoc.session'

export function getSession(): Session | null {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null')
  } catch {
    return null
  }
}

export function setSession(s: Session | null) {
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s))
  else localStorage.removeItem(SESSION_KEY)
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body: any) {
    super(message)
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const session = getSession()
  const res = await fetch(cfg.apiUrl + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(session ? { authorization: `Bearer ${session.token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error ?? data.status ?? `HTTP_${res.status}`, data.message ?? res.statusText, data)
  return data as T
}

export function toB64(u: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}

export const fromB64 = (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0))

export const navigate = (hash: string) => {
  window.location.hash = hash
}

const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#9a6324', '#800000', '#808000', '#000075']
export function colorFor(key: string): string {
  let h = 0
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]
}
