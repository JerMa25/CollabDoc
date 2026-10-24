import { describe, expect, it } from 'vitest'
import { renderPdf } from '../src/lib/pdf'

describe('renderPdf', () => {
  it('renders long multi-page text with accents and unsupported characters', async () => {
    const text = 'Été à Douala — “journal” 🚀 '.repeat(2000)
    const bytes = await renderPdf('Journal', text, 'footer')
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-')
    expect(bytes.length).toBeGreaterThan(1000)
  })
})
