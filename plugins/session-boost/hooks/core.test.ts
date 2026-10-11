import type { SessionMessage, ToolUseSummary } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { describeActivity, finalAnswer, mainDigest, PROGRESS_TOOL, summarizeCall, watcherPrompt } from './core'

const use = (tool: string, input: Record<string, unknown>, done?: { result?: unknown; text?: string }): ToolUseSummary => ({
  tool_use_id: `t-${tool}`,
  tool,
  input,
  ...done,
})
const assistant = (text: string, toolUses: ToolUseSummary[] = []): SessionMessage => ({ role: 'assistant', text, toolUses })
const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

test('summarizeCall picks the most telling argument, in key order', async () => {
  expect(summarizeCall('Grep', { pattern: 'foo' })).toBe('Grep foo')
  expect(summarizeCall('Read', { file_path: 'a.ts', pattern: 'x' })).toBe('Read a.ts')
  expect(summarizeCall('Agent', { description: 'Find it', prompt: 'long' })).toBe('Agent Find it')
  expect(summarizeCall('Bash', { command: 'ls\n  -la' })).toBe('Bash ls -la')
})

test('summarizeCall skips blank and non-string values and truncates at 80', async () => {
  expect(summarizeCall('Bash', { description: '   ', command: 'npm test' })).toBe('Bash npm test')
  expect(summarizeCall('X', { path: 42 })).toBe('X')
  expect(summarizeCall('X', {})).toBe('X')
  const long = summarizeCall('Bash', { command: 'a'.repeat(200) })
  expect(long).toBe(`Bash ${'a'.repeat(79)}…`)
})

test('describeActivity shows an in-flight tool use (no result, no text)', async () => {
  const messages = [assistant('', [use('Grep', { pattern: 'callSite' })])]
  expect(describeActivity(messages)).toBe('▸ Grep callSite')
})

test('describeActivity prefers the in-flight use over finished ones and over text', async () => {
  const messages = [
    assistant('Looking now', [use('Read', { file_path: 'a.ts' }, { text: 'ok' }), use('Grep', { pattern: 'p' })]),
  ]
  expect(describeActivity(messages)).toBe('▸ Grep p')
})

test('describeActivity: a use with only a result or only text is finished', async () => {
  expect(describeActivity([assistant('', [use('Read', { file_path: 'a.ts' }, { result: {} })])])).toBe('✓ Read a.ts')
  expect(describeActivity([assistant('', [use('Read', { file_path: 'b.ts' }, { text: 'x' })])])).toBe('✓ Read b.ts')
})

test('describeActivity shows text over a finished tool use', async () => {
  const messages = [assistant('Found  three\ncall sites', [use('Grep', { pattern: 'p' }, { text: 'r' })])]
  expect(describeActivity(messages)).toBe('Found three call sites')
})

test('describeActivity reads the last assistant row, skipping user rows', async () => {
  const messages = [assistant('first'), user('tool output'), assistant('', [use('Bash', { command: 'ls' })]), user('')]
  expect(describeActivity(messages)).toBe('▸ Bash ls')
})

test('describeActivity: nothing yet is "starting…"', async () => {
  expect(describeActivity([])).toBe('starting…')
  expect(describeActivity([user('hi')])).toBe('starting…')
  expect(describeActivity([assistant('  ')])).toBe('starting…')
})

test('finalAnswer is the last non-blank assistant text, trimmed and capped', async () => {
  expect(finalAnswer([assistant('one'), assistant(' two '), assistant(''), user('u')])).toBe('two')
  expect(finalAnswer([user('only user')])).toBe('(no answer)')
  const capped = finalAnswer([assistant('x'.repeat(5000))])
  expect(capped).toHaveLength(4001)
  expect(capped).toEndWith('…')
})

test('mainDigest renders roles, text and tool calls, keeping the last rows', async () => {
  const digest = mainDigest([user('fix the bug'), assistant('On it', [use('Read', { file_path: 'a.ts' })])])
  expect(digest).toBe('User: fix the bug\nAssistant: On it\n  - Read a.ts')
  const many = Array.from({ length: 20 }, (_, i) => user(`m${i}`))
  const tail = mainDigest(many, 3)
  expect(tail).toBe('User: m17\nUser: m18\nUser: m19')
  expect(mainDigest([])).toBe('')
})

test('watcherPrompt embeds the task and digest, with fallbacks', async () => {
  const prompt = watcherPrompt('fix it', 'User: fix it')
  expect(prompt).toContain('<task>\nfix it\n</task>')
  expect(prompt).toContain('<conversation_so_far>\nUser: fix it\n</conversation_so_far>')
  expect(prompt).toEndWith(`Start your loop by calling ${PROGRESS_TOOL}.`)
  const empty = watcherPrompt('', '')
  expect(empty).toContain('(the turn started without a typed prompt')
  expect(empty).toContain('(nothing yet)')
})

import { cheaperModels, classifyJob, describeOption, priceOf } from './core'

test('priceOf reads every spelling of a model name', () => {
  expect(priceOf('claude-opus-5-5')).toMatchObject({ input: 4, output: 20 })
  expect(priceOf('Opus 5.5 (1M context)')).toMatchObject({ input: 4, output: 20 })
  expect(priceOf('claude-opus-4-8')).toEqual({ input: 5, output: 25 })
  expect(priceOf('sonnet')).toMatchObject({ input: 2, output: 10 })
  expect(priceOf('claude-fable-5-1')).toMatchObject({ input: 10, output: 50 })
  expect(priceOf('gpt-x')).toBeUndefined()
})

test('classifyJob reads the type, the description, then the tools used', () => {
  expect(classifyJob('claude-code-guide', 'Verify plugin marketplace docs', [])).toBe('lookup')
  expect(classifyJob('Explore', 'Find call sites', ['Grep', 'Read'])).toBe('lookup')
  expect(classifyJob('general-purpose', 'Review session-boost logic', ['Read'])).toBe('reasoning')
  expect(classifyJob('Plan', 'Implementation plan', [])).toBe('reasoning')
  expect(classifyJob('general-purpose', 'Write and run mod tests', ['Write', 'Bash'])).toBe('coding')
  expect(classifyJob('general-purpose', 'Fix the bug', ['Grep', 'WebFetch'])).toBe('lookup')
})

test('cheaperModels suits the job and undercuts the chat', () => {
  const ids = (parent: string, job: 'lookup' | 'coding' | 'reasoning') => cheaperModels(parent, job).map(m => m.id)
  expect(ids('claude-opus-5-5', 'lookup')).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5'])
  expect(ids('claude-opus-5-5', 'coding')).toEqual(['claude-sonnet-5-5'])
  expect(ids('claude-opus-5-5', 'reasoning')).toEqual([])
  expect(ids('claude-fable-5-1', 'reasoning')).toEqual(['claude-opus-5-5'])
  expect(ids('claude-haiku-5-5', 'lookup')).toEqual([])
  expect(ids('unknown-model', 'lookup')).toEqual([])
})

test('describeOption names the price and the saving', () => {
  const [sonnet, haiku] = cheaperModels('claude-opus-5-5', 'lookup')
  expect(describeOption(sonnet!, 'claude-opus-5-5')).toBe('Sonnet 5.5 ($2/$10, 50% less)')
  expect(describeOption(haiku!, 'claude-opus-5-5')).toBe('Haiku 5.5 ($0.10/$0.50, 98% less)')
})

import { recommendedModel } from './core'

test('recommendedModel is the cheapest capable model below the one a subagent runs on', () => {
  expect(recommendedModel('claude-opus-5-5', 'lookup')?.label).toBe('Haiku 5.5')
  expect(recommendedModel('claude-opus-5-5', 'coding')?.label).toBe('Sonnet 5.5')
  expect(recommendedModel('claude-fable-5-1', 'reasoning')?.label).toBe('Opus 5.5')
  expect(recommendedModel('claude-opus-5-5', 'reasoning')).toBeUndefined()
  expect(recommendedModel('claude-haiku-5-5', 'lookup')).toBeUndefined()
  expect(recommendedModel('claude-sonnet-5-5', 'coding')).toBeUndefined()
  expect(recommendedModel(undefined, 'lookup')).toBeUndefined()
})
