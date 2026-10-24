// Shared helpers for the end-to-end / load test scripts (they only use the public API).
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import * as Y from 'yjs'

/** API / WebSocket URLs: from env, or read from the deployed CloudFormation stack. */
export function endpoints() {
  if (process.env.API_URL && process.env.WS_URL) return { api: process.env.API_URL, ws: process.env.WS_URL }
  const region = process.env.AWS_REGION ?? 'eu-north-1'
  const q = (k) =>
    execSync(`aws cloudformation describe-stacks --region ${region} --stack-name collabdoc --query "Stacks[0].Outputs[?OutputKey=='${k}'].OutputValue" --output text`).toString().trim()
  return { api: q('ApiUrl'), ws: q('WebSocketUrl') }
}

export const RUN = process.env.RUN_ID ?? new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)

export async function call(api, method, path, body, token, extraHeaders = {}) {
  const t0 = performance.now()
  const res = await fetch(api + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data, ms: performance.now() - t0 }
}

export async function must(api, method, path, body, token) {
  const r = await call(api, method, path, body, token)
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`)
  return r.data
}

export const session = (api, name, email) => must(api, 'POST', '/session', { name, email })

/** Creates a document owned by `owner` and gives access to every writer. */
export async function setupDoc(api, owner, writers, title) {
  const doc = await must(api, 'POST', '/documents', { title }, owner.token)
  for (let i = 0; i < writers.length; i += 20) {
    await Promise.all(writers.slice(i, i + 20).map((w) => must(api, 'POST', `/documents/${doc.docId}/members`, { email: w.email }, owner.token)))
  }
  return doc
}

export const b64 = (u) => Buffer.from(u).toString('base64')
export const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'))
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Applies `fn` to the Y.Text of `doc` and returns the resulting incremental update. */
export function localEdit(doc, fn) {
  const before = Y.encodeStateVector(doc)
  fn(doc.getText('content'))
  return Y.encodeStateAsUpdate(doc, before)
}

/**
 * Sends an update like the real client does: same id on every retry, retry on network error,
 * 429 and 5xx. Returns { accepted, status, attempts, ms }.
 */
export async function sendUpdate(api, token, docId, id, update) {
  const t0 = performance.now()
  for (let attempt = 1; attempt <= 12; attempt++) {
    let r
    try {
      r = await call(api, 'POST', `/documents/${docId}/updates`, { id, update: b64(update) }, token)
    } catch {
      r = { status: 0 }
    }
    if (r.status === 200) return { accepted: true, status: 200, attempts: attempt, ms: performance.now() - t0, data: r.data }
    if (r.status && r.status < 500 && r.status !== 429) return { accepted: false, status: r.status, attempts: attempt, ms: performance.now() - t0, data: r.data }
    await sleep(Math.min(4000, 200 * 2 ** attempt) * (0.5 + Math.random() / 2))
  }
  return { accepted: false, status: 'gave_up', attempts: 12, ms: performance.now() - t0 }
}

export async function serverText(api, token, docId) {
  const { state } = await must(api, 'GET', `/documents/${docId}/state`, undefined, token)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, fromB64(state))
  return doc.getText('content').toString()
}

export function percentiles(values) {
  const v = [...values].sort((a, b) => a - b)
  const p = (q) => (v.length ? Math.round(v[Math.min(v.length - 1, Math.floor(q * v.length))]) : null)
  return { count: v.length, p50: p(0.5), p90: p(0.9), p99: p(0.99), max: v.length ? Math.round(v[v.length - 1]) : null }
}

export function saveResult(name, data) {
  mkdirSync(new URL('./results/', import.meta.url), { recursive: true })
  const file = new URL(`./results/${name}-${RUN}.json`, import.meta.url)
  writeFileSync(file, JSON.stringify(data, null, 2))
  return file.pathname
}
