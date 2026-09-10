export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

export const PRELOADED_CLIENT_EXTERNALS: readonly string[] = []

export function optionalStringArray(subject: string, field: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`client-modules: ${subject} ${field} must be a string array`)
  }
  return value as string[]
}

export function clientBuildEnvironmentDefines(environment: NodeJS.ProcessEnv): Record<string, string> {
  const values = Object.entries(environment)
    .filter(([name, value]) => name.startsWith('DSH_CLIENT_') && value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return Object.fromEntries([
    ['process.env', '{}'],
    ...values.map(([name, value]) => [`process.env.${name}`, JSON.stringify(value)]),
  ])
}
