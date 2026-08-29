import PDFDocument from 'pdfkit'
import { formatCurrency, formatDate } from '@maction/utils'

/**
 * Branded PDF quotation rendering for orders.
 *
 * This module is intentionally free of any database or S3 imports so it can be
 * unit-tested in isolation: it accepts a fully-resolved, framework-agnostic view
 * model and returns the rendered PDF bytes. The order service owns loading the
 * order/customer/company data and uploading the resulting buffer to S3.
 */

/** Tenant branding pulled from the `companies` table. */
export interface QuotationBranding {
  companyName: string
  taxRate: number
}

/** A single rendered quotation line. Free-goods lines carry a zero unit price. */
export interface QuotationLine {
  materialName: string
  qty: number
  uom: string
  unitPrice: number
  discountPercentage: number
  subtotal: number
  isFreeGoods: boolean
}

/** Fully-resolved view model for a quotation document. */
export interface QuotationData {
  branding: QuotationBranding
  orderNumber: string
  orderDate: string
  customerName: string
  lines: QuotationLine[]
  subtotalAmount: number
  totalDiscountAmount: number
  taxAmount: number
  grandTotal: number
}

const PAGE_MARGIN = 50
const FONT_TITLE = 20
const FONT_HEADING = 12
const FONT_BODY = 9

/** Column x-offsets (from the left margin) for the line-items table. */
const COLUMNS = { name: 0, qty: 235, uom: 285, price: 335, disc: 420, subtotal: 470 } as const

/**
 * Renders a branded PDF quotation and resolves with the complete document bytes.
 * Streams pdfkit chunks into a buffer and resolves on the document's `end` event.
 */
export function renderQuotationPdf(data: QuotationData): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN })
    const chunks: Uint8Array[] = []

    doc.on('data', (chunk: Uint8Array) => chunks.push(chunk))
    doc.on('end', () => resolve(concatChunks(chunks)))
    doc.on('error', reject)

    drawHeader(doc, data)
    drawMeta(doc, data)
    const bottomY = drawLineItems(doc, data.lines)
    drawTotals(doc, data, bottomY)

    doc.end()
  })
}

/** Concatenates streamed pdfkit chunks into a single byte array. */
function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** Draws the tenant-branded header (company name as branded text) and title. */
function drawHeader(doc: PDFKit.PDFDocument, data: QuotationData): void {
  doc.font('Helvetica-Bold').fontSize(FONT_TITLE).fillColor('#1C4173')
  doc.text(data.branding.companyName, { align: 'left' })
  doc.moveDown(0.2)
  doc.font('Helvetica-Bold').fontSize(FONT_HEADING).fillColor('#111111')
  doc.text('SALES QUOTATION')
  doc.moveDown(0.5)
}

/** Draws order metadata: number, date, and customer. */
function drawMeta(doc: PDFKit.PDFDocument, data: QuotationData): void {
  doc.font('Helvetica').fontSize(FONT_BODY).fillColor('#333333')
  doc.text(`Quotation No : ${data.orderNumber}`)
  doc.text(`Date         : ${formatDate(data.orderDate)}`)
  doc.text(`Customer     : ${data.customerName}`)
  doc.moveDown(0.8)
}

/** Draws the line-items table header + rows; returns the y-position after the last row. */
function drawLineItems(doc: PDFKit.PDFDocument, lines: QuotationLine[]): number {
  const left = doc.page.margins.left
  let y = doc.y

  doc.font('Helvetica-Bold').fontSize(FONT_BODY).fillColor('#111111')
  drawRow(doc, left, y, ['Item', 'Qty', 'UOM', 'Unit Price', 'Disc %', 'Subtotal'])
  y += 16
  doc.moveTo(left, y - 4).lineTo(left + 500, y - 4).strokeColor('#CCCCCC').stroke()

  doc.font('Helvetica').fillColor('#333333')
  for (const line of lines) {
    y = drawLineRow(doc, left, y, line)
  }
  return y + 6
}

/** Draws a single line-item row and returns the next y-position. */
function drawLineRow(doc: PDFKit.PDFDocument, left: number, y: number, line: QuotationLine): number {
  const name = line.isFreeGoods ? `${line.materialName} (FREE GOODS)` : line.materialName
  drawRow(doc, left, y, [
    name,
    String(line.qty),
    line.uom,
    formatCurrency(line.unitPrice),
    line.discountPercentage.toFixed(1),
    formatCurrency(line.subtotal),
  ])
  return y + 14
}

/** Renders one table row using the fixed column offsets. */
function drawRow(doc: PDFKit.PDFDocument, left: number, y: number, cells: readonly string[]): void {
  const [name, qty, uom, price, disc, subtotal] = cells
  doc.text(name ?? '', left + COLUMNS.name, y, { width: 225 })
  doc.text(qty ?? '', left + COLUMNS.qty, y, { width: 40, align: 'right' })
  doc.text(uom ?? '', left + COLUMNS.uom, y, { width: 40 })
  doc.text(price ?? '', left + COLUMNS.price, y, { width: 75, align: 'right' })
  doc.text(disc ?? '', left + COLUMNS.disc, y, { width: 40, align: 'right' })
  doc.text(subtotal ?? '', left + COLUMNS.subtotal, y, { width: 80, align: 'right' })
}

/** Draws the totals block (subtotal, discount, PPN, grand total). */
function drawTotals(doc: PDFKit.PDFDocument, data: QuotationData, startY: number): void {
  const left = doc.page.margins.left
  doc.moveTo(left, startY).lineTo(left + 500, startY).strokeColor('#CCCCCC').stroke()

  let y = startY + 8
  const rows: Array<[string, string]> = [
    ['Subtotal', formatCurrency(data.subtotalAmount)],
    ['Total Discount', formatCurrency(data.totalDiscountAmount)],
    [`PPN (${data.branding.taxRate.toFixed(0)}%)`, formatCurrency(data.taxAmount)],
  ]

  doc.font('Helvetica').fontSize(FONT_BODY).fillColor('#333333')
  for (const [label, value] of rows) {
    y = drawTotalRow(doc, left, y, label, value, false)
  }
  doc.font('Helvetica-Bold').fillColor('#111111')
  drawTotalRow(doc, left, y + 2, 'Grand Total', formatCurrency(data.grandTotal), true)
}

/** Draws a single right-aligned totals row and returns the next y-position. */
function drawTotalRow(
  doc: PDFKit.PDFDocument,
  left: number,
  y: number,
  label: string,
  value: string,
  emphasize: boolean
): number {
  doc.text(label, left + 300, y, { width: 120, align: 'right' })
  doc.text(value, left + 420, y, { width: 80, align: 'right' })
  return y + (emphasize ? 16 : 14)
}
