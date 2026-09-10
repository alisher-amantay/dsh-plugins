import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { renderPdfPages, selectPdfPages } from '../src/pdf.ts'

async function fixture(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  document.addPage([100, 100])
  document.addPage([120, 80])
  return document.save()
}

describe('selectPdfPages', () => {
  it('bounds the default window and validates explicit selections', () => {
    expect(selectPdfPages(25, undefined, undefined, 20)).toEqual({
      pages: Array.from({ length: 20 }, (_, index) => index + 1),
      pageCount: 25,
      truncated: true,
    })
    expect(selectPdfPages(3, 2, undefined, 20)).toEqual({ pages: [2], pageCount: 3, truncated: false })
    expect(selectPdfPages(4, undefined, { start: 2, end: 4 }, 20)).toEqual({
      pages: [2, 3, 4], pageCount: 4, truncated: false,
    })
    expect(() => selectPdfPages(4, 1, { start: 1, end: 2 }, 20)).toThrow(/cannot be used together/u)
    expect(() => selectPdfPages(4, undefined, { start: 1, end: 4 }, 2)).toThrow(/exceeding/u)
  })
})

describe('renderPdfPages', () => {
  it('renders selected pages and rejects oversized canvas allocations', async () => {
    const data = await fixture()
    const rendered = await renderPdfPages(data, 1, undefined, 20, 1, 10_000, new AbortController().signal)
    expect(rendered.selection.pages).toEqual([1])
    expect([...rendered.pages[0]!.data.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])

    await expect(renderPdfPages(data, 1, undefined, 20, 2, 10_000, new AbortController().signal))
      .rejects.toThrow(/maxPagePixels/u)
  })
})
