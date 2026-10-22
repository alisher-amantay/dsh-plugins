/**
 * Vendor the Web Chat client of the sibling Harness checkout into
 * `packages/client-chat-extended/src` and apply the one behavioural edit the
 * package exists for.
 *
 * Every source file is copied verbatim, so an upstream change surfaces here as
 * a reviewable diff instead of drifting silently; `tests/vendor-drift.spec.ts`
 * rejects a copy that is behind the checkout. Each edit must match its anchor
 * exactly once, so an upstream rename fails here instead of shipping a package
 * that quietly lost its reason to exist.
 *
 * Run `node build/vendor-ui-chat.ts` after updating the Harness checkout.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { harnessRoot } from './preset-overrides.ts'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Harness package directory whose `src` is the vendoring source. */
export const UI_CHAT_SOURCE = resolve(harnessRoot, 'packages/client/ui-chat/src')

/** Package directory receiving the vendored copy. */
export const CHAT_EXTENDED_ROOT = resolve(repositoryRoot, 'packages/client-chat-extended')

/** Vendored `src` directory inside {@link CHAT_EXTENDED_ROOT}. */
export const VENDORED_SOURCE = resolve(CHAT_EXTENDED_ROOT, 'src')

/** One anchored, single-occurrence edit applied after copying. */
export interface VendoredEdit {
  /** Package-relative path inside the vendored `src`. */
  readonly file: string
  /** Exact upstream text to replace. */
  readonly before: string
  /** Replacement text carrying the plugin's behaviour. */
  readonly after: string
}

/**
 * The Chat behaviour this package adds: the generic model-activity status
 * yields while a foreground tool call already reports its exact work.
 * Background jobs do not count, so model activity stays visible beside them.
 */
export const CHAT_EDITS: readonly VendoredEdit[] = [
  {
    file: 'client/chat/ChatFlow.tsx',
    before: '  const running = useSession(snapshot => snapshot.running)\n',
    after: '  const running = useSession(snapshot => snapshot.running)\n'
      + '  const hasRunningToolCall = useChat(snapshot => snapshot.legacy.runningCalls.length > 0)\n',
  },
  {
    file: 'client/chat/ChatFlow.tsx',
    before: '  return [...rows, ...pendingRows, ...running ? [<RunningStatus key="running" startTime={runningStartTime} t={t} />] : []]\n})\n',
    after: '  // Model activity spans request and streaming phases; a running foreground\n'
      + '  // tool already exposes the exact work, so the generic status yields to it.\n'
      + '  const showRunningStatus = running && !hasRunningToolCall\n'
      + '  return [...rows, ...pendingRows, ...showRunningStatus ? [<RunningStatus key="running" startTime={runningStartTime} t={t} />] : []]\n'
      + '})\n',
  },
]

/**
 * List every file below a directory as slash-separated relative paths.
 * @param root - directory to walk.
 * @param current - directory being visited; defaults to `root`.
 * @returns sorted relative paths.
 */
function listFiles(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(current, entry.name)
      if (entry.isDirectory()) return listFiles(root, path)
      if (!entry.isFile()) throw new Error(`unsupported entry in the vendored tree: ${path}`)
      return relative(root, path).split(sep).join('/')
    })
    .sort()
}

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 * @param haystack - text to search.
 * @param needle - literal to find.
 * @returns occurrence count.
 */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/**
 * Apply every edit that targets `file`.
 * @param file - package-relative path.
 * @param text - upstream content.
 * @returns content carrying the plugin's behaviour.
 */
function applyEdits(file: string, text: string): string {
  let result = text
  for (const edit of CHAT_EDITS.filter(candidate => candidate.file === file)) {
    const found = occurrences(result, edit.before)
    if (found !== 1) {
      throw new Error(`${file}: the vendoring anchor matched ${found} times, expected exactly 1:\n${edit.before}`)
    }
    result = result.replace(edit.before, edit.after)
  }
  return result
}

/**
 * Render the complete vendored `src` tree from the Harness checkout.
 * @returns map of package-relative `src` path to file content, sorted by path.
 */
export function renderVendoredUiChat(): Map<string, Buffer> {
  if (!existsSync(UI_CHAT_SOURCE)) {
    throw new Error(`missing Harness Chat sources at ${UI_CHAT_SOURCE}; set DSH_HARNESS_ROOT or check out ../deepseek-harness`)
  }
  const rendered = new Map<string, Buffer>()
  for (const file of listFiles(UI_CHAT_SOURCE)) {
    const content = readFileSync(join(UI_CHAT_SOURCE, file))
    const text = content.toString('utf8')
    // Binary assets (the running-whale image) carry no edit and survive byte-for-byte.
    const edited = applyEdits(file, text)
    rendered.set(file, edited === text ? content : Buffer.from(edited, 'utf8'))
  }
  for (const edit of CHAT_EDITS) {
    if (!rendered.has(edit.file)) throw new Error(`the vendoring edit targets a file the Harness checkout no longer ships: ${edit.file}`)
  }
  return rendered
}

/**
 * List the files currently present in the vendored `src` tree.
 * @returns sorted relative paths.
 */
export function vendoredFileList(): string[] {
  return listFiles(VENDORED_SOURCE)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rendered = renderVendoredUiChat()
  const previous = vendoredFileList()
  for (const [file, content] of rendered) {
    const target = resolve(VENDORED_SOURCE, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  const removed = previous.filter(file => !rendered.has(file))
  for (const file of removed) rmSync(resolve(VENDORED_SOURCE, file))
  for (const file of previous) {
    const directory = dirname(resolve(VENDORED_SOURCE, file))
    if (directory !== VENDORED_SOURCE && readdirSync(directory).length === 0) rmSync(directory, { recursive: true })
  }
  console.log(`vendored ${rendered.size} files from ${UI_CHAT_SOURCE}${removed.length === 0 ? '' : `; removed ${removed.length} stale files`}`)
}
