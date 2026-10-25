// Server-side helpers around Yjs (the CRDT used for collaborative editing).
// The server never trusts the client's own count of written characters: it decodes the
// binary update and counts the characters it actually inserts.
import * as Y from 'yjs'
import { TEXT_KEY } from './config'
import { HttpError } from './http'

/**
 * Number of characters inserted by an update. Characters that were inserted and deleted
 * again before being sent (ContentDeleted / GC) are counted too: the credit is consumed by
 * what was written, which keeps the count conservative (never under-counts).
 * Throws 400 for updates that are not plain-text edits of the shared Y.Text.
 */
export function countInsertedChars(update: Uint8Array): number {
  let decoded: ReturnType<typeof Y.decodeUpdate>
  try {
    decoded = Y.decodeUpdate(update)
  } catch {
    throw new HttpError(400, 'INVALID_UPDATE', 'Update is not a valid Yjs update')
  }
  let chars = 0
  for (const struct of decoded.structs) {
    if (struct instanceof Y.Skip) continue
    if (struct instanceof Y.GC) {
      chars += struct.length
      continue
    }
    const item = struct as Y.Item
    if (item.parentSub !== null) throw new HttpError(400, 'INVALID_UPDATE', 'Only plain text edits are allowed')
    if (typeof item.parent === 'string' && item.parent !== TEXT_KEY) throw new HttpError(400, 'INVALID_UPDATE', 'Unknown shared type')
    if (item.content instanceof Y.ContentString) chars += item.content.str.length
    else if (item.content instanceof Y.ContentDeleted) chars += item.content.len
    else throw new HttpError(400, 'INVALID_UPDATE', 'Only plain text edits are allowed')
  }
  return chars
}

/** Merges many updates into one (order does not matter: CRDT merge is commutative). */
export function mergeUpdates(updates: Uint8Array[]): Uint8Array {
  if (updates.length === 0) return Y.encodeStateAsUpdate(new Y.Doc())
  return Y.mergeUpdates(updates)
}

export function docFromState(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc
}

export function textFromState(state: Uint8Array): string {
  return docFromState(state).getText(TEXT_KEY).toString()
}

/** The part of `state` that a client with state vector `sv` does not have yet. */
export function diffFromStateVector(state: Uint8Array, sv: Uint8Array): Uint8Array {
  try {
    return Y.diffUpdate(state, sv)
  } catch {
    throw new HttpError(400, 'INVALID_STATE_VECTOR', 'sv is not a valid Yjs state vector')
  }
}

/** Builds the update that turns the current state into `targetText` (used by version restore). */
export function replaceTextUpdate(state: Uint8Array, targetText: string): Uint8Array {
  const doc = docFromState(state)
  const before = Y.encodeStateVector(doc)
  const text = doc.getText(TEXT_KEY)
  doc.transact(() => {
    text.delete(0, text.length)
    text.insert(0, targetText)
  })
  return Y.encodeStateAsUpdate(doc, before)
}
