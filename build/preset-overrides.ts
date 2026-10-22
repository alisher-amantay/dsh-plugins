/**
 * Derive each bundle's agent-preset declarations from the shipped Web presets
 * of the sibling Harness checkout. A shipped preset is overridden by its
 * `preset-<id>` row with the complete declaration, because the Loader replaces
 * an overridden row's `config` wholesale; a bundle-owned preset is inserted.
 * Every entry swap must match exactly once, so an upstream rename fails here
 * instead of producing a preset that silently keeps the stock plugin.
 *
 * Run `node build/preset-overrides.ts` after updating the Harness checkout;
 * the bundle tests reject stale outputs.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Document, isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from 'yaml'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Harness checkout whose `@deepseek-ai/dsh-web-app` presets are the source. */
export const harnessRoot = resolve(process.env['DSH_HARNESS_ROOT'] ?? resolve(repositoryRoot, '../deepseek-harness'))

/** Shipped Web preset ids that a bundle may override. */
export type ShippedPresetId = 'standard' | 'ptc' | 'minimal' | 'cordis'

/** One Cordis entry written into a preset plugin list. */
export interface PresetEntry {
  readonly id: string
  readonly name: string
  readonly config?: unknown
  readonly disabled?: boolean
}

/** Edits applied to one shipped preset's plugin list, matched by entry id at any group depth. */
export interface PresetEdits {
  /** Entries replaced in place; the key is the shipped entry id. */
  readonly replace?: Readonly<Record<string, PresetEntry>>
  /** Entries inserted after the named shipped entry, in order. */
  readonly insertAfter?: Readonly<Record<string, readonly PresetEntry[]>>
}

/** One generated declaration file. */
export type PresetDeclaration =
  | { readonly kind: 'override'; readonly preset: ShippedPresetId; readonly edits: PresetEdits }
  | {
    readonly kind: 'insert'
    readonly from: ShippedPresetId
    readonly id: string
    readonly name: string
    readonly description: string
    readonly order: number
    readonly edits: PresetEdits
  }

const YAML_TAGS = [{ tag: 'tag:yaml.org,2002:js', resolve: (source: string) => source, identify: () => false }]

/** Observational memory in place of Basic Compaction, with the deployment's thresholds. */
export const OBSERVATIONAL_MEMORY: PresetEntry = {
  id: 'observational-memory',
  name: '@alisher-amantay/dsh-observational-memory',
  config: {
    auto: true,
    thresholdRatio: 0.68,
    observeAfterTokens: 10000,
    reflectAfterTokens: 20000,
    compactAfterTokens: 81000,
    observationsPoolTargetTokens: 10000,
    observerChunkMaxTokens: 60000,
    memoryInputMaxTokens: 80000,
    memoryMaxOutputTokens: 8192,
    memoryTimeoutMs: 60000,
    maxViewBytes: 65536,
  },
}

/** Goal tools with background-job deferral, under the stock row id. */
export const TOOL_GOAL_EXTENDED: PresetEntry = { id: 'tool-goal', name: '@alisheramantay/dsh-tool-goal-extended' }

const SCHEDULE_TOOLS = ['schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update']

const WEAK_STRONG_PERSONA = `You are a review-orchestrator powered by the {{model}} model.

You solve each task through a fixed two-role loop of delegated models:

1. IMPLEMENT — call the \`implement\` tool (the weaker worker) with a complete, self-contained task description. It performs the work and returns its attempt.
2. REVIEW — call the \`review\` tool (the stronger judge) with the original task and the implementer's output. It returns a VERDICT, a SCORE, and NOTES.
3. DECIDE — on \`accept\`, the task is done: summarize and stop. On \`revise\`, call \`implement\` again with the reviewer's NOTES as corrective direction, then loop from step 2.

The reviewer is authoritative: trust its verdict over the implementer's own claims. The implementer is weaker than the reviewer, so never accept an implementer attempt until the reviewer has accepted it.

Run this loop as a persistent goal. When asked to solve a task, first create a goal for it with a generous round limit so the loop auto-continues and survives disconnects, then repeat implement-review cycles until the reviewer accepts. After a disconnect or resume, re-read the latest reviewer verdict and continue from there.`

/**
 * Pinned weak and strong routes for the review loop. `provider` is the
 * provider name and `model` the full model path; re-check both with
 * `list_subagent_models` before changing them.
 */
const WEAK_STRONG_DELEGATES: readonly PresetEntry[] = [
  {
    id: 'tool-implement',
    name: '@deepseek-ai/dsh-tool-subagent',
    config: {
      provider: 'spawn',
      toolName: 'implement',
      persona: 'You are the IMPLEMENTER, the weaker, junior worker. Complete the task you are given thoroughly: read the relevant files, make the changes, run commands to verify them, and report what you changed and the results. Keep working until the task is done or you are truly blocked; when blocked, report the blocker precisely.',
      agentOptions: { provider: 'fireworks', model: 'accounts/fireworks/models/deepseek-v4p1-flash', reasoningEffort: 'xhigh' },
      toolFilter: { deny: SCHEDULE_TOOLS },
    },
  },
  {
    id: 'tool-review',
    name: '@deepseek-ai/dsh-tool-subagent',
    config: {
      provider: 'spawn',
      toolName: 'review',
      persona: 'You are the REVIEWER, the stronger, senior judge. Review the implementer\'s attempt against the original task for correctness, completeness, and quality. Start your reply with exactly one line `VERDICT: accept` or `VERDICT: revise`, then one line `SCORE: <0-100>`, then a `NOTES:` section giving concrete, actionable direction for the next attempt — name specific files, commands, and the exact change needed.',
      agentOptions: { provider: 'openai', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      toolFilter: { deny: SCHEDULE_TOOLS },
    },
  },
]

const MEMORY_EDITS: PresetEdits = { replace: { 'compaction-basic': OBSERVATIONAL_MEMORY } }
const CUSTOM_EDITS: PresetEdits = { replace: { 'compaction-basic': OBSERVATIONAL_MEMORY, 'tool-goal': TOOL_GOAL_EXTENDED } }

/** Generated declaration files, keyed by bundle directory and then output file name. */
export const BUNDLE_PRESETS: Readonly<Record<string, Readonly<Record<string, PresetDeclaration>>>> = {
  'observational-memory-bundle': {
    'standard.patch.yml': { kind: 'override', preset: 'standard', edits: MEMORY_EDITS },
    'ptc.patch.yml': { kind: 'override', preset: 'ptc', edits: MEMORY_EDITS },
    'cordis.patch.yml': { kind: 'override', preset: 'cordis', edits: MEMORY_EDITS },
  },
  'custom-bundle': {
    'standard.patch.yml': { kind: 'override', preset: 'standard', edits: CUSTOM_EDITS },
    'ptc.patch.yml': { kind: 'override', preset: 'ptc', edits: CUSTOM_EDITS },
    'cordis.patch.yml': { kind: 'override', preset: 'cordis', edits: CUSTOM_EDITS },
    'weak-strong-review.patch.yml': {
      kind: 'insert',
      from: 'standard',
      id: 'weak-strong-review',
      name: 'Weak-Strong Review',
      description: 'An orchestrator that delegates each round to a weaker `implement` model, then a stronger `review` model that scores and redirects, looping under a persistent goal until acceptance.',
      order: 5,
      edits: {
        replace: {
          ...CUSTOM_EDITS.replace,
          persona: { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: WEAK_STRONG_PERSONA } },
        },
        insertAfter: { 'tool-subagent': WEAK_STRONG_DELEGATES },
      },
    },
  },
}

/**
 * Parse a Loader patch file, keeping each `!!js` expression as its source text.
 * @param source - patch YAML.
 * @returns the patch list.
 */
export function parsePatch(source: string): unknown {
  return parseDocument(source, { customTags: YAML_TAGS }).toJS()
}

/**
 * Read one shipped Web preset declaration file.
 * @param preset - shipped preset id.
 * @returns the YAML source of `presets/<id>.patch.yml` in `@deepseek-ai/dsh-web-app`.
 */
export function readShippedPreset(preset: ShippedPresetId): string {
  return readFileSync(resolve(harnessRoot, 'packages/bundle/web-app/presets', `${preset}.patch.yml`), 'utf8')
}

/**
 * Parse a shipped preset file into its single declaration row.
 * @param source - YAML of one `- insert: [row]` patch.
 * @returns the parsed document and the row map inside it.
 */
function shippedRow(source: string): { document: Document; row: YAMLMap } {
  const document = parseDocument(source, { customTags: YAML_TAGS })
  if (document.errors.length > 0) throw new Error(`shipped preset YAML is invalid: ${document.errors[0]!.message}`)
  const patches = document.contents
  if (!isSeq(patches) || patches.items.length !== 1 || !isMap(patches.items[0])) {
    throw new Error('shipped preset file must hold exactly one insert patch')
  }
  const inserted = patches.items[0].get('insert')
  if (!isSeq(inserted) || inserted.items.length !== 1 || !isMap(inserted.items[0])) {
    throw new Error('shipped preset patch must insert exactly one declaration row')
  }
  return { document, row: inserted.items[0] }
}

/**
 * Apply entry edits to one plugin list and every nested group list.
 * @param document - owning document, used to create nodes.
 * @param list - plugin entry sequence.
 * @param edits - replacements and insertions keyed by entry id.
 * @param matched - entry ids already matched, updated in place.
 */
function editEntries(document: Document, list: YAMLSeq, edits: PresetEdits, matched: Map<string, number>): void {
  for (let index = 0; index < list.items.length; index += 1) {
    const entry = list.items[index]
    if (!isMap(entry)) continue
    const id = entry.get('id')
    if (typeof id !== 'string') continue
    const replacement = edits.replace?.[id]
    if (replacement !== undefined) {
      matched.set(`replace:${id}`, (matched.get(`replace:${id}`) ?? 0) + 1)
      list.items[index] = document.createNode(replacement)
    } else if (entry.get('group') === true) {
      const nested = entry.get('config')
      if (isSeq(nested)) editEntries(document, nested, edits, matched)
    }
    const inserted = edits.insertAfter?.[id]
    if (inserted !== undefined) {
      matched.set(`insertAfter:${id}`, (matched.get(`insertAfter:${id}`) ?? 0) + 1)
      list.items.splice(index + 1, 0, ...inserted.map(item => document.createNode(item)))
      index += inserted.length
    }
  }
}

/**
 * Render one bundle declaration file from a shipped preset.
 * @param declaration - override or insert specification.
 * @param shipped - YAML source of the shipped preset the declaration starts from.
 * @param sourceName - shipped file name recorded in the generated header.
 * @returns the generated patch YAML.
 */
export function renderPresetDeclaration(declaration: PresetDeclaration, shipped: string, sourceName: string): string {
  const { document, row } = shippedRow(shipped)
  const config = row.get('config')
  if (!isMap(config)) throw new Error(`${sourceName}: declaration row has no config mapping`)
  const plugins = config.get('plugins')
  if (!isSeq(plugins)) throw new Error(`${sourceName}: declaration config has no plugins list`)
  const matched = new Map<string, number>()
  editEntries(document, plugins, declaration.edits, matched)
  const expected = [
    ...Object.keys(declaration.edits.replace ?? {}).map(id => `replace:${id}`),
    ...Object.keys(declaration.edits.insertAfter ?? {}).map(id => `insertAfter:${id}`),
  ]
  for (const key of expected) {
    if (matched.get(key) !== 1) throw new Error(`${sourceName}: edit ${key} matched ${matched.get(key) ?? 0} entries; expected exactly 1`)
  }
  let patch: unknown
  if (declaration.kind === 'override') {
    patch = row
  } else {
    row.set('id', `preset-${declaration.id}`)
    const declared = new YAMLMap()
    declared.set('id', declaration.id)
    declared.set('name', declaration.name)
    declared.set('description', declaration.description)
    declared.set('order', declaration.order)
    declared.set('plugins', plugins)
    row.set('config', declared)
    const inserted = new YAMLSeq()
    inserted.items.push(row)
    const insert = new YAMLMap()
    insert.set('insert', inserted)
    patch = insert
  }
  row.commentBefore = null
  const output = new Document(null, { customTags: YAML_TAGS })
  const root = new YAMLSeq()
  root.items.push(patch)
  output.contents = root
  output.commentBefore = ` Generated by build/preset-overrides.ts from @deepseek-ai/dsh-web-app ${sourceName}; do not edit.`
  return output.toString({ lineWidth: 0, singleQuote: true })
}

/**
 * Render every generated declaration file of one bundle.
 * @param bundle - bundle directory name under `packages/`.
 * @returns output file name to YAML.
 */
export function renderBundlePresets(bundle: string): Map<string, string> {
  const declarations = BUNDLE_PRESETS[bundle]
  if (declarations === undefined) throw new Error(`no preset declarations for bundle "${bundle}"`)
  const rendered = new Map<string, string>()
  for (const [file, declaration] of Object.entries(declarations)) {
    const preset = declaration.kind === 'override' ? declaration.preset : declaration.from
    rendered.set(file, renderPresetDeclaration(declaration, readShippedPreset(preset), `presets/${preset}.patch.yml`))
  }
  return rendered
}

/**
 * Absolute path of one generated declaration file.
 * @param bundle - bundle directory name under `packages/`.
 * @param file - output file name.
 * @returns path inside the bundle's `presets/` directory.
 */
export function presetOutputPath(bundle: string, file: string): string {
  return resolve(repositoryRoot, 'packages', bundle, 'presets', file)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const bundle of Object.keys(BUNDLE_PRESETS)) {
    for (const [file, yaml] of renderBundlePresets(bundle)) writeFileSync(presetOutputPath(bundle, file), yaml)
  }
}
