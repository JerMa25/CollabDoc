import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { countInsertedChars, mergeUpdates, replaceTextUpdate, textFromState } from '../src/lib/yjs'

const edit = (fn: (t: Y.Text) => void, base?: Uint8Array) => {
  const doc = new Y.Doc()
  if (base) Y.applyUpdate(doc, base)
  const sv = Y.encodeStateVector(doc)
  fn(doc.getText('content'))
  return Y.encodeStateAsUpdate(doc, sv)
}

describe('countInsertedChars', () => {
  it('counts inserted characters', () => {
    expect(countInsertedChars(edit((t) => t.insert(0, 'hello')))).toBe(5)
  })
  it('does not charge deletions of existing text', () => {
    const base = edit((t) => t.insert(0, 'hello world'))
    expect(countInsertedChars(edit((t) => t.delete(0, 6), base))).toBe(0)
  })
  it('charges text inserted then deleted before sending (conservative)', () => {
    const u = edit((t) => { t.insert(0, 'abcdef'); t.delete(0, 6) })
    expect(countInsertedChars(u)).toBeGreaterThanOrEqual(6)
  })
  it('rejects non-text content', () => {
    const doc = new Y.Doc()
    doc.getMap('evil').set('k', 'v')
    expect(() => countInsertedChars(Y.encodeStateAsUpdate(doc))).toThrow()
  })
  it('rejects garbage', () => {
    expect(() => countInsertedChars(new Uint8Array([1, 2, 3, 250, 250]))).toThrow()
  })
})

describe('convergence (CRDT properties the server relies on)', () => {
  it('concurrent inserts at the same position converge whatever the merge order', () => {
    const base = edit((t) => t.insert(0, '[]'))
    const a = edit((t) => t.insert(1, 'AAA'), base)
    const b = edit((t) => t.insert(1, 'BBB'), base)
    const c = edit((t) => t.insert(1, 'CCC'), base)
    const t1 = textFromState(mergeUpdates([base, a, b, c]))
    const t2 = textFromState(mergeUpdates([c, b, base, a]))
    expect(t1).toBe(t2)
    for (const s of ['AAA', 'BBB', 'CCC']) expect(t1).toContain(s)
  })
  it('applying an update twice changes nothing (idempotent retries)', () => {
    const a = edit((t) => t.insert(0, 'once'))
    expect(textFromState(mergeUpdates([a, a]))).toBe('once')
  })
  it('restore produces an update that yields the target text', () => {
    const state = edit((t) => t.insert(0, 'current text'))
    const restore = replaceTextUpdate(state, 'old version')
    expect(textFromState(mergeUpdates([state, restore]))).toBe('old version')
  })
})
