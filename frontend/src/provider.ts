// Synchronises a local Y.Doc with the server.
//  - Local edits are batched (~80 ms) and sent with HTTP POST, ONE request in flight at a time.
//    Each batch has a unique id: on a network error it is resent with the same id, and the
//    server stores/charges it only once. An edit is only "accepted" when the server says so.
//  - Remote edits and presence arrive through the WebSocket. Applying an update twice is a
//    no-op in Yjs, so echoes of our own edits are harmless.
//  - After every (re)connection the full state is fetched again, so nothing missed while
//    offline is lost.
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import { api, ApiError, cfg, fromB64, toB64, type Credit } from './api'

const REMOTE = 'remote'
const FATAL = new Set([400, 401, 403, 404, 413, 423])

export interface ProviderEvents {
  onStatus(status: 'connecting' | 'online' | 'offline'): void
  onSynced(): void
  onAck(credit: Credit): void
  onReject(code: string, body: any): void
  /** 'saving' while local edits are not yet accepted by the server, 'saved' once they all are. */
  onSaveState?(state: 'saving' | 'saved' | 'retrying'): void
}

export class DocProvider {
  private ws?: WebSocket
  private pending: Uint8Array[] = []
  private inflight?: { id: string; data: string }
  private seq = 0
  private synced = false
  private destroyed = false
  private flushTimer?: ReturnType<typeof setTimeout>
  private awarenessTimer?: ReturnType<typeof setTimeout>
  private httpRetry = 500
  private wsRetry = 1000

  constructor(private docId: string, private token: string, private doc: Y.Doc, private awareness: Awareness, private ev: ProviderEvents) {
    doc.on('update', this.onDocUpdate)
    awareness.on('update', this.onAwarenessUpdate)
    this.connect()
  }

  get unsentCount() {
    return this.pending.length + (this.inflight ? 1 : 0)
  }

  // ---------------------------------------------------------------- outgoing edits
  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) return
    this.pending.push(update)
    this.ev.onSaveState?.('saving')
    this.scheduleFlush(80)
  }

  private scheduleFlush(delay: number) {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flush()
    }, delay)
  }

  private async flush() {
    if (this.destroyed || this.inflight || !this.synced || this.pending.length === 0) return
    const merged = Y.mergeUpdates(this.pending)
    this.pending = []
    this.inflight = { id: `${this.doc.clientID}-${Date.now().toString(36)}-${this.seq++}`, data: toB64(merged) }
    await this.sendInflight()
  }

  private async sendInflight() {
    const item = this.inflight
    if (!item || this.destroyed) return
    try {
      const res = await api<{ credit: Credit }>('POST', `/documents/${this.docId}/updates`, { id: item.id, update: item.data })
      this.inflight = undefined
      this.httpRetry = 500
      this.ev.onAck(res.credit)
      if (this.pending.length) this.scheduleFlush(0)
      else this.ev.onSaveState?.('saved')
    } catch (e) {
      if (e instanceof ApiError && FATAL.has(e.status)) {
        // Rejected (credit exhausted, blocked, ...): this edit and the following local ones
        // will not be part of the document. The page reloads the state from the server.
        this.inflight = undefined
        this.pending = []
        this.ev.onSaveState?.('saved')
        this.ev.onReject(e.code, e.body)
        return
      }
      // Network error, 429 or 5xx: retry the SAME id later (idempotent on the server).
      this.ev.onSaveState?.('retrying')
      setTimeout(() => void this.sendInflight(), this.httpRetry)
      this.httpRetry = Math.min(this.httpRetry * 2, 8000)
    }
  }

  // ---------------------------------------------------------------- WebSocket
  private connect() {
    if (this.destroyed) return
    this.ev.onStatus('connecting')
    const url = `${cfg.wsUrl}?token=${encodeURIComponent(this.token)}&docId=${encodeURIComponent(this.docId)}&cid=${this.doc.clientID}`
    const ws = new WebSocket(url)
    this.ws = ws
    ws.onopen = async () => {
      this.wsRetry = 1000
      this.ev.onStatus('online')
      await this.loadState()
      this.sendAwareness()
    }
    ws.onmessage = (m) => {
      let msg: any
      try {
        msg = JSON.parse(m.data)
      } catch {
        return
      }
      if (msg.type === 'update') Y.applyUpdate(this.doc, fromB64(msg.data), REMOTE)
      else if (msg.type === 'awareness') applyAwarenessUpdate(this.awareness, fromB64(msg.data), REMOTE)
      else if (msg.type === 'join') this.sendAwareness()
      else if (msg.type === 'leave' && typeof msg.cid === 'number') removeAwarenessStates(this.awareness, [msg.cid], REMOTE)
    }
    ws.onclose = () => {
      if (this.ws !== ws || this.destroyed) return
      this.ev.onStatus('offline')
      setTimeout(() => this.connect(), this.wsRetry)
      this.wsRetry = Math.min(this.wsRetry * 2, 10000)
    }
  }

  private async loadState() {
    try {
      const res = await api<{ state: string }>('GET', `/documents/${this.docId}/state`)
      Y.applyUpdate(this.doc, fromB64(res.state), REMOTE)
      if (!this.synced) {
        this.synced = true
        this.ev.onSynced()
        this.scheduleFlush(0)
      }
    } catch (e) {
      console.error('state load failed', e)
      setTimeout(() => void this.loadState(), 2000)
    }
  }

  // ---------------------------------------------------------------- presence
  private onAwarenessUpdate = (_changes: unknown, origin: unknown) => {
    if (origin === REMOTE || this.awarenessTimer) return
    this.awarenessTimer = setTimeout(() => {
      this.awarenessTimer = undefined
      this.sendAwareness()
    }, 150)
  }

  private sendAwareness() {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const data = toB64(encodeAwarenessUpdate(this.awareness, [this.doc.clientID]))
    this.ws.send(JSON.stringify({ action: 'awareness', data }))
  }

  destroy() {
    this.destroyed = true
    this.doc.off('update', this.onDocUpdate)
    this.awareness.off('update', this.onAwarenessUpdate)
    clearTimeout(this.flushTimer)
    clearTimeout(this.awarenessTimer)
    this.ws?.close()
  }
}
