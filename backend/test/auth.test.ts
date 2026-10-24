import { describe, expect, it } from 'vitest'
import { signToken, validateWriter, verifyToken } from '../src/lib/auth'

describe('session tokens', () => {
  const w = { name: 'Alice', email: 'alice@example.com' }
  it('round-trips', () => {
    expect(verifyToken(signToken(w, 's3cret'), 's3cret')).toEqual(w)
  })
  it('rejects a tampered or foreign token', () => {
    const t = signToken(w, 's3cret')
    expect(verifyToken(t, 'other')).toBeNull()
    const forged = Buffer.from(JSON.stringify({ n: 'Eve', e: 'eve@x.io', exp: 9e9 })).toString('base64url') + '.' + t.split('.')[1]
    expect(verifyToken(forged, 's3cret')).toBeNull()
  })
  it('rejects expired tokens', () => {
    expect(verifyToken(signToken(w, 's', 0), 's', 10 ** 10)).toBeNull()
  })
  it('normalizes e-mail', () => {
    expect(validateWriter({ name: ' Bob ', email: ' BOB@Example.com ' })).toEqual({ name: 'Bob', email: 'bob@example.com' })
    expect(() => validateWriter({ name: 'x', email: 'nope' })).toThrow()
  })
})
