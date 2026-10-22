/**
 * The vendored Chat client must be the Harness Chat client plus the documented
 * edits, nothing else. Run `node build/vendor-ui-chat.ts` after a Harness bump.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHAT_EDITS, renderVendoredUiChat, VENDORED_SOURCE, vendoredFileList } from '../../../build/vendor-ui-chat.ts'

describe('vendored Chat client', () => {
  it('mirrors the Harness Chat sources with only the documented edits', () => {
    const rendered = renderVendoredUiChat()
    const vendored = new Set(vendoredFileList())
    const stale = [...vendored].filter(file => !rendered.has(file))
    expect(stale, 'the vendored copy ships files the Harness no longer has; run node build/vendor-ui-chat.ts')
      .toEqual([])
    const drifted = [...rendered]
      .filter(([file, content]) => !vendored.has(file) || Buffer.compare(readFileSync(resolve(VENDORED_SOURCE, file)), content) !== 0)
      .map(([file]) => file)
    expect(drifted, 'the vendored copy is behind the Harness checkout; run node build/vendor-ui-chat.ts')
      .toEqual([])
  })

  it('carries each edit that justifies the fork', () => {
    const rendered = renderVendoredUiChat()
    for (const edit of CHAT_EDITS) {
      const content = readFileSync(resolve(VENDORED_SOURCE, edit.file), 'utf8')
      // Additive edits keep their anchor, so applied means one copy of the result.
      expect(content.split(edit.after)).toHaveLength(2)
      expect(rendered.get(edit.file)?.toString('utf8')).toBe(content)
    }
  })
})
