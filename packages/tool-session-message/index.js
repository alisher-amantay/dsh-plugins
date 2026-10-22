import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-session-message'
export const inject = ['tools', 'sessionController']

const MAX_MESSAGE_CHARS = 20_000

/** Compact, model-facing row for one Session. */
function row(item) {
  const values = item.projections?.values ?? {}
  const out = {
    sessionId: String(item.sessionId),
    running: item.running,
    updatedAt: new Date(item.updatedAt).toISOString(),
  }
  if (typeof values.title === 'string') out.title = values.title
  if (item.cwd !== undefined) out.cwd = item.cwd
  return out
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'list_sessions',
    description: 'List other Sessions in this Host (most recent first) so one can be addressed by send_session_message. Subagent Sessions and blank Sessions are omitted. Read-only.',
    parameters: {
      limit: { type: 'integer', description: 'Maximum rows to return. Defaults to 20, maximum 100.' },
      cwd_contains: { type: 'string', description: 'Only Sessions whose working directory contains this text.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                running: { type: 'boolean', required: true },
                updatedAt: { type: 'string', required: true },
                title: { type: 'string' },
                cwd: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: () => ({ card: 'generic', title: 'List sessions', kind: 'read' }),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const limit = Math.min(Math.max(args.limit ?? 20, 1), 100)
      const { items } = await ctx.sessionController.list({}, exec.signal)
      const self = exec.agent?.session?.id
      const sessions = items
        .filter(item => item.origin !== 'subagent' && !item.blank && item.sessionId !== self)
        .filter(item => args.cwd_contains === undefined || (item.cwd ?? '').includes(args.cwd_contains))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map(row)
      return { sessions }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'send_session_message',
    description: 'Send a message to ANOTHER Session as a user prompt, on behalf of the human user. Use only when the user asked you to message that Session. The text is prefixed with a notice that it was relayed by this session on the user\'s behalf, so the recipient can tell. Default mode "queue" runs after the recipient\'s current turn; "steer" injects into its running turn. Find ids with list_sessions. Delivery is acknowledged, not the recipient\'s reply.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Target Session id from list_sessions. Must not be this session.' },
      text: { type: 'string', required: true, description: 'Message body, self-contained for the recipient.' },
      mode: { type: 'string', enum: ['queue', 'steer'], description: 'Delivery mode. Defaults to "queue".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
          sessionId: { type: 'string', required: true },
          requestId: { type: 'string', required: true },
          mode: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: args => ({ card: 'generic', title: 'Send session message', kind: 'other', rawInput: args.session_id }),
    async execute(args, exec) {
      const target = String(args.session_id).trim()
      const body = String(args.text)
      if (target.length === 0) throw new Error('session_id must be non-empty')
      if (body.trim().length === 0) throw new Error('text must contain non-whitespace content')
      if (body.length > MAX_MESSAGE_CHARS) throw new Error(`text exceeds ${MAX_MESSAGE_CHARS} characters`)
      const self = exec.agent?.session?.id
      if (self !== undefined && target === String(self)) throw new Error('refusing to send a message to the calling session')
      const known = await ctx.sessionController.list({}, exec.signal)
      if (!known.items.some(item => String(item.sessionId) === target)) {
        throw new Error(`unknown session "${target}"; use list_sessions`)
      }
      const mode = args.mode ?? 'queue'
      const requestId = randomUUID()
      const origin = self === undefined ? 'another session' : `session ${self}`
      const text = `[Relayed from ${origin} on the user's behalf]\n\n${body}`
      await ctx.sessionController.prompt({
        requestId,
        sessionId: target,
        mode,
        content: [{ type: 'text', text }],
      }, exec.signal)
      return { accepted: true, sessionId: target, requestId, mode }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'rename_session',
    description: 'Set the title of a Session shown in the sidebar. Use when the user asks to rename a Session, or to label one this session created. Omit session_id to rename the calling session. Find ids with list_sessions.',
    parameters: {
      session_id: { type: 'string', description: 'Target Session id from list_sessions. Omit to rename the calling session.' },
      title: { type: 'string', required: true, description: 'New title, short and descriptive.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          title: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: args => ({ card: 'generic', title: 'Rename session', kind: 'other', rawInput: args.title }),
    async execute(args, exec) {
      const self = exec.agent?.session?.id
      const target = args.session_id === undefined ? (self === undefined ? '' : String(self)) : String(args.session_id).trim()
      if (target.length === 0) throw new Error('session_id is required when the calling session is unknown')
      const title = String(args.title).trim()
      if (title.length === 0) throw new Error('title must be non-empty')
      if (target !== String(self)) {
        const known = await ctx.sessionController.list({}, exec.signal)
        if (!known.items.some(item => String(item.sessionId) === target)) {
          throw new Error(`unknown session "${target}"; use list_sessions`)
        }
      }
      const accepted = await ctx.sessionController.rename({ sessionId: target, title })
      return { sessionId: target, title: accepted.title }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'create_session',
    description: 'Start a NEW top-level Session (appears in the sidebar, independent of this one) on the user\'s behalf, optionally titled and seeded with a first prompt that starts its turn immediately. Use only when the user asked for a new session or a parallel workstream. The prompt must be self-contained: the new Session has no access to this conversation. The prompt is prefixed with a relay notice. Returns the new session id for later send_session_message/list_sessions use.',
    parameters: {
      cwd: { type: 'string', description: 'Absolute working directory for the new Session. Defaults to this session\'s working directory.' },
      title: { type: 'string', description: 'Sidebar title for the new Session.' },
      prompt: { type: 'string', description: 'First user prompt; starts a turn right away. Without it the Session is blank and stays hidden from the sidebar and list_sessions until it gets its first prompt.' },
      agent_preset: { type: 'string', description: 'Agent preset id. Omit for the default.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          cwd: { type: 'string', required: true },
          title: { type: 'string' },
          prompted: { type: 'boolean', required: true },
          requestId: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: args => ({ card: 'generic', title: 'Create session', kind: 'other', rawInput: args.title ?? args.cwd }),
    async execute(args, exec) {
      const body = args.prompt === undefined ? undefined : String(args.prompt)
      if (body !== undefined && body.trim().length === 0) throw new Error('prompt must contain non-whitespace content')
      if (body !== undefined && body.length > MAX_MESSAGE_CHARS) throw new Error(`prompt exceeds ${MAX_MESSAGE_CHARS} characters`)
      const cwd = args.cwd === undefined ? exec.agent?.session?.header?.cwd : String(args.cwd).trim()
      if (cwd !== undefined && !String(cwd).startsWith('/')) throw new Error('cwd must be an absolute path')
      const created = await ctx.sessionController.create({
        ...(cwd === undefined ? {} : { cwd: String(cwd) }),
        ...(args.agent_preset === undefined ? {} : { agentPreset: String(args.agent_preset) }),
      })
      const sessionId = String(created.sessionId)
      const out = { sessionId, cwd: cwd === undefined ? '' : String(cwd), prompted: false }
      if (args.title !== undefined && String(args.title).trim().length > 0) {
        const renamed = await ctx.sessionController.rename({ sessionId, title: String(args.title).trim() })
        out.title = renamed.title
      }
      if (body !== undefined) {
        const self = exec.agent?.session?.id
        const origin = self === undefined ? 'another session' : `session ${self}`
        const requestId = randomUUID()
        await ctx.sessionController.prompt({
          requestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: `[Started by ${origin} on the user's behalf]\n\n${body}` }],
        }, exec.signal)
        out.prompted = true
        out.requestId = requestId
      }
      return out
    },
  }))
}
