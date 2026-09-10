import { basename, extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { renderPdfPages } from './pdf.ts'
import type { PdfPageRange } from './pdf.ts'

export const name = 'tool-pdf'
export const inject = ['fs', 'tools']

/** PDF source, selection, and raster-allocation policy. */
export interface Config {
  maxSourceBytes?: number
  pageLimit?: number
  renderScale?: number
  maxPagePixels?: number
}

export const Config: z<Config> = z.object({
  maxSourceBytes: z.number().step(1).min(1).default(50 * 1024 * 1024),
  pageLimit: z.number().step(1).min(1).default(20),
  renderScale: z.number().min(0.25).max(4).default(2),
  maxPagePixels: z.number().step(1).min(1).default(24_000_000),
})

interface PdfReadValue {
  path: string
  pageCount: number
  renderedPages: number[]
  truncated: boolean
  images: Array<{
    attachmentId: string
    mediaType: 'image/png'
    bytes: number
    width: number
    height: number
    name?: string
    originalDimensions?: { width: number; height: number }
  }>
}

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
  },
} as const

function resolveOptions(exec: ToolExecution, requestedPath: string): { cwd?: string; signal?: AbortSignal } {
  const rawCwd = exec.agent?.session.header.cwd
  const traversesParent = /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(requestedPath)
  const cwd = rawCwd === undefined ? undefined : traversesParent ? canonicalPath(rawCwd) : rawCwd
  return { ...cwd === undefined ? {} : { cwd }, signal: exec.signal }
}

function isPdf(data: Uint8Array): boolean {
  return data.byteLength >= 5
    && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46 && data[4] === 0x2d
}

function imageRef(image: PdfReadValue['images'][number]): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...image.name === undefined ? {} : { name: image.name },
    ...image.originalDimensions === undefined ? {} : { originalDimensions: { ...image.originalDimensions } },
  }
}

function renderValue(value: PdfReadValue): ContentBlock[] {
  const first = value.renderedPages[0]
  const last = value.renderedPages.at(-1)
  const shown = first === last ? `page ${String(first)}` : `pages ${String(first)}-${String(last)}`
  const omitted = value.pageCount - value.renderedPages.length
  const truncation = value.truncated
    ? `\nTRUNCATED: ${omitted} page${omitted === 1 ? '' : 's'} omitted. Call read_pdf with page or page_range to continue.`
    : ''
  return [
    {
      type: 'text',
      text: `<path>${value.path}</path>\n<type>document</type>\n<content>\nPDF ${shown} of ${value.pageCount} rendered as PNG for vision.${truncation}\n</content>`,
    },
    ...value.images.map(image => ({ type: 'image' as const, attachment: imageRef(image) })),
  ]
}

async function assertImageRoute(ctx: Context, exec: ToolExecution, requestedPath: string): Promise<void> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error(`cannot read "${requestedPath}" as PDF pages: the current model route could not be resolved`)
  }
  const info = await llm.resolveModelInfo(provider, model, exec.signal)
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(`cannot read "${requestedPath}" as PDF pages: model "${model}" does not declare image input`)
  }
}

/** Register the dedicated `read_pdf` vision tool when attachment storage is available. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = {
    maxSourceBytes: config.maxSourceBytes ?? 50 * 1024 * 1024,
    pageLimit: config.pageLimit ?? 20,
    renderScale: config.renderScale ?? 2,
    maxPagePixels: config.maxPagePixels ?? 24_000_000,
  }
  ctx.inject(['attachments'], (toolCtx) => {
    toolCtx.tools.register(defineTool({
      name: 'read_pdf',
      description: 'Render selected PDF pages as images for the current vision-capable model. Provide one 1-based page or inclusive page_range; omitting both renders the first bounded page window and reports truncation.',
      parameters: {
        file_path: { type: 'string', required: true, description: 'Path to a PDF resolved by the current filesystem backend.' },
        page: { type: 'integer', description: 'One 1-based page; mutually exclusive with page_range.' },
        page_range: {
          type: 'object',
          additionalProperties: false,
          description: 'Inclusive 1-based page range; mutually exclusive with page.',
          properties: {
            start: { type: 'integer', required: true },
            end: { type: 'integer', required: true },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            pageCount: { type: 'integer', required: true },
            renderedPages: { type: 'array', items: { type: 'integer' }, required: true },
            truncated: { type: 'boolean', required: true },
            images: { type: 'array', items: IMAGE_SCHEMA, required: true },
          },
        },
        render: (_args, value) => renderValue(value),
      },
      presentCall: args => ({ card: 'generic', title: 'Read PDF', kind: 'read', rawInput: args.file_path }),
      async execute(args, exec) {
        if (extname(args.file_path).toLowerCase() !== '.pdf') throw new Error('read_pdf requires a .pdf path')
        await assertImageRoute(toolCtx, exec, args.file_path)
        const target = await toolCtx.fs.resolve(args.file_path, resolveOptions(exec, args.file_path))
        const info = await toolCtx.fs.stat(target, exec.signal)
        if (info === undefined) {
          toolCtx.emit('fs/observed', target, { kind: 'absent' }, exec)
          throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
        }
        if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
        const data = await toolCtx.fs.readBytes(target, exec.signal, resolved.maxSourceBytes)
        if (!isPdf(data)) throw new Error(`cannot read "${target.displayPath}": the .pdf extension does not match the file content`)
        const pageLimit = Math.min(resolved.pageLimit, toolCtx.attachments.imageLimits.maxImagesPerMessage)
        const rendered = await renderPdfPages(
          data,
          args.page,
          args.page_range as PdfPageRange | undefined,
          pageLimit,
          resolved.renderScale,
          resolved.maxPagePixels,
          exec.signal,
        )
        const refs = await toolCtx.attachments.saveImages(rendered.pages.map(item => ({
          data: item.data,
          mediaType: 'image/png',
          name: `${basename(target.displayPath)}-page-${item.page}.png`,
        })))
        toolCtx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
        return {
          path: target.displayPath,
          pageCount: rendered.selection.pageCount,
          renderedPages: rendered.selection.pages,
          truncated: rendered.selection.truncated,
          images: refs.map(ref => ({
            attachmentId: ref.attachmentId,
            mediaType: 'image/png' as const,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...ref.name === undefined ? {} : { name: ref.name },
            ...ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } },
          })),
        }
      },
    }))
  })
}
