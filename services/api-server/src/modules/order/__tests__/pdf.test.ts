import { describe, it, expect } from 'bun:test'

import { renderQuotationPdf, type QuotationData } from '../pdf'

/** Builds a representative quotation view model, overridable per test. */
function makeQuotation(overrides: Partial<QuotationData> = {}): QuotationData {
  return {
    branding: { companyName: 'Kimia Farma Trading', taxRate: 11 },
    orderNumber: 'ORD-20250101-0001',
    orderDate: '2025-01-01',
    customerName: 'Apotek Sehat Sentosa',
    lines: [
      {
        materialName: 'Paracetamol 500mg',
        qty: 10,
        uom: 'BOX',
        unitPrice: 25000,
        discountPercentage: 5,
        subtotal: 237500,
        isFreeGoods: false,
      },
      {
        materialName: 'Vitamin C 1000mg',
        qty: 2,
        uom: 'STRIP',
        unitPrice: 0,
        discountPercentage: 0,
        subtotal: 0,
        isFreeGoods: true,
      },
    ],
    subtotalAmount: 237500,
    totalDiscountAmount: 12500,
    taxAmount: 26125,
    grandTotal: 263625,
    ...overrides,
  }
}

/** Reads the leading bytes of a buffer as an ASCII string for header assertions. */
function leadingAscii(bytes: Uint8Array, length: number): string {
  return Buffer.from(bytes.subarray(0, length)).toString('latin1')
}

describe('order/pdf renderQuotationPdf', () => {
  it('produces a non-empty PDF buffer with a valid PDF header', async () => {
    const bytes = await renderQuotationPdf(makeQuotation())

    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBeGreaterThan(0)
    expect(leadingAscii(bytes, 5)).toBe('%PDF-')
  })

  it('ends with a PDF end-of-file marker', async () => {
    const bytes = await renderQuotationPdf(makeQuotation())
    const trailer = Buffer.from(bytes.subarray(bytes.length - 8)).toString('latin1')

    expect(trailer).toContain('%%EOF')
  })

  it('renders a valid document with no line items', async () => {
    const bytes = await renderQuotationPdf(makeQuotation({ lines: [] }))

    expect(bytes.length).toBeGreaterThan(0)
    expect(leadingAscii(bytes, 5)).toBe('%PDF-')
  })

  it('renders a larger document as more line items are added', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      materialName: `Material ${i}`,
      qty: i + 1,
      uom: 'PCS',
      unitPrice: 1000 * (i + 1),
      discountPercentage: 0,
      subtotal: 1000 * (i + 1) * (i + 1),
      isFreeGoods: false,
    }))

    const small = await renderQuotationPdf(makeQuotation({ lines: [] }))
    const large = await renderQuotationPdf(makeQuotation({ lines: many }))

    expect(large.length).toBeGreaterThan(small.length)
  })
})
