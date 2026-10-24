// PDF rendering (pure JavaScript, pdf-lib) and S3 caching.
// A PDF is cached in S3 under the document revision (`pdf/<docId>/<rev>.pdf`). Every accepted
// edit increments `rev`, so a link used at T1 always gets a PDF built from the state at T1:
// either the cached file of the current revision, or a freshly rendered one.
import { HeadObjectCommand, PutObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib'
import { config, PDF_URL_TTL_SEC } from './config'
import { getDocument, loadDocState } from './docstate'
import { textFromState } from './yjs'

export const s3 = new S3Client({})

const PAGE = { width: 595.28, height: 841.89, margin: 56 }
const FONT_SIZE = 11
const LINE_HEIGHT = 15

/** Replaces characters the standard PDF font cannot encode (outside WinAnsi) with '?'. */
function sanitize(text: string, font: PDFFont): string {
  const ok = new Map<string, boolean>()
  let out = ''
  for (const ch of text.replace(/\r/g, '').replace(/\t/g, '    ')) {
    if (ch === '\n') { out += ch; continue }
    let supported = ok.get(ch)
    if (supported === undefined) {
      try { font.encodeText(ch); supported = true } catch { supported = false }
      ok.set(ch, supported)
    }
    out += supported ? ch : '?'
  }
  return out
}

function wrapLines(text: string, font: PDFFont, maxWidth: number): string[] {
  const width = (s: string) => font.widthOfTextAtSize(s, FONT_SIZE)
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word
      if (width(candidate) <= maxWidth) { line = candidate; continue }
      if (line) lines.push(line)
      // A single word longer than the line is cut character by character.
      line = ''
      for (const ch of word) {
        if (width(line + ch) > maxWidth) { lines.push(line); line = '' }
        line += ch
      }
    }
    lines.push(line)
  }
  return lines
}

export async function renderPdf(title: string, text: string, footer: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(title)
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const maxWidth = PAGE.width - 2 * PAGE.margin

  let page = pdf.addPage([PAGE.width, PAGE.height])
  let y = PAGE.height - PAGE.margin
  page.drawText(sanitize(title, bold), { x: PAGE.margin, y: y - 18, size: 18, font: bold })
  y -= 18 + 24

  for (const line of wrapLines(sanitize(text, font), font, maxWidth)) {
    if (y < PAGE.margin + LINE_HEIGHT) {
      page = pdf.addPage([PAGE.width, PAGE.height])
      y = PAGE.height - PAGE.margin
    }
    page.drawText(line, { x: PAGE.margin, y: y - FONT_SIZE, size: FONT_SIZE, font })
    y -= LINE_HEIGHT
  }
  const pages = pdf.getPages()
  pages.forEach((p, i) =>
    p.drawText(sanitize(`${footer} - page ${i + 1}/${pages.length}`, font), { x: PAGE.margin, y: 24, size: 8, font }),
  )
  return pdf.save()
}

async function exists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: config.dataBucket, Key: key }))
    return true
  } catch (e: any) {
    // Without s3:ListBucket (not granted: least privilege) S3 answers 403 for a missing key.
    const status = e?.$metadata?.httpStatusCode
    if (status === 404 || status === 403 || e?.name === 'NotFound') return false
    throw e
  }
}

/** Returns the S3 key of the PDF for the document's current state, rendering it if needed. */
export async function ensureCurrentPdf(docId: string): Promise<{ key: string; title: string; rev: number }> {
  const doc = await getDocument(docId, true)
  const rev = Number(doc.rev ?? 0)
  const key = `pdf/${docId}/${rev}.pdf`
  if (!(await exists(key))) {
    // Updates are read AFTER rev: the PDF contains at least everything up to `rev`.
    const { state } = await loadDocState(docId)
    const bytes = await renderPdf(doc.title, textFromState(state), `${doc.title} - revision ${rev} - ${new Date().toISOString()}`)
    await s3.send(new PutObjectCommand({ Bucket: config.dataBucket, Key: key, Body: bytes, ContentType: 'application/pdf' }))
  }
  return { key, title: doc.title, rev }
}

export function presignPdf(key: string, title: string): Promise<string> {
  const filename = (title.normalize('NFD').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'document') + '.pdf'
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: config.dataBucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${filename}"`,
      ResponseContentType: 'application/pdf',
    }),
    { expiresIn: PDF_URL_TTL_SEC },
  )
}
