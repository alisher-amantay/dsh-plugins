import { createCanvas } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

/** One caller-selected, 1-based inclusive page interval. */
export interface PdfPageRange {
  start: number
  end: number
}

/** Selection metadata known before any page is rasterized. */
export interface PdfPageSelection {
  pages: number[]
  pageCount: number
  truncated: boolean
}

/** A selected PDF page rendered as PNG bytes. */
export interface RenderedPdfPage {
  page: number
  data: Uint8Array
}

function assertPageNumber(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive 1-based integer`)
}

/** Resolve one page, one inclusive range, or the default first-page window. */
export function selectPdfPages(
  pageCount: number,
  page: number | undefined,
  pageRange: PdfPageRange | undefined,
  limit: number,
): PdfPageSelection {
  if (page !== undefined && pageRange !== undefined) throw new Error('page and page_range cannot be used together')
  if (page !== undefined) {
    assertPageNumber('page', page)
    if (page > pageCount) throw new Error(`page ${page} is out of range for a ${pageCount}-page PDF`)
    return { pages: [page], pageCount, truncated: false }
  }
  if (pageRange !== undefined) {
    assertPageNumber('page_range.start', pageRange.start)
    assertPageNumber('page_range.end', pageRange.end)
    if (pageRange.start > pageRange.end) throw new Error('page_range.start must be less than or equal to page_range.end')
    if (pageRange.end > pageCount) throw new Error(`page range ${pageRange.start}-${pageRange.end} is out of range for a ${pageCount}-page PDF`)
    const requested = pageRange.end - pageRange.start + 1
    if (requested > limit) throw new Error(`page range selects ${requested} pages, exceeding the ${limit}-page PDF limit`)
    return { pages: Array.from({ length: requested }, (_, index) => pageRange.start + index), pageCount, truncated: false }
  }
  const count = Math.min(pageCount, limit)
  return {
    pages: Array.from({ length: count }, (_, index) => index + 1),
    pageCount,
    truncated: pageCount > limit,
  }
}

/** Parse a PDF and render selected pages without exceeding the configured canvas allocation. */
export async function renderPdfPages(
  data: Uint8Array,
  page: number | undefined,
  pageRange: PdfPageRange | undefined,
  pageLimit: number,
  renderScale: number,
  maxPagePixels: number,
  signal: AbortSignal,
): Promise<{ selection: PdfPageSelection; pages: RenderedPdfPage[] }> {
  signal.throwIfAborted()
  const loading = getDocument({
    data: Uint8Array.from(data),
    useSystemFonts: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    stopAtErrors: true,
  })
  try {
    const document = await loading.promise
    const selection = selectPdfPages(document.numPages, page, pageRange, pageLimit)
    const pages: RenderedPdfPage[] = []
    for (const pageNumber of selection.pages) {
      signal.throwIfAborted()
      const pdfPage = await document.getPage(pageNumber)
      const viewport = pdfPage.getViewport({ scale: renderScale })
      const width = Math.max(1, Math.ceil(viewport.width))
      const height = Math.max(1, Math.ceil(viewport.height))
      if (width * height > maxPagePixels) {
        throw new Error(`page ${pageNumber} raster is ${width}x${height}, exceeding maxPagePixels ${maxPagePixels}`)
      }
      const canvas = createCanvas(width, height)
      const canvasContext = canvas.getContext('2d')
      canvasContext.fillStyle = '#ffffff'
      canvasContext.fillRect(0, 0, width, height)
      await pdfPage.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: canvasContext as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise
      pages.push({ page: pageNumber, data: canvas.toBuffer('image/png') })
      pdfPage.cleanup()
    }
    return { selection, pages }
  } finally {
    await loading.destroy()
  }
}
