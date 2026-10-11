import type { SessionMessage } from 'claude-code'

export const PLUGIN = 'session-boost'
export const PANE = 'subagents'
export const WATCHER_TYPE = `${PLUGIN}:watcher`
export const HELPER_TYPE = `${PLUGIN}:helper`
export const PROGRESS_TOOL = `mcp__${PLUGIN}__progress`
export const SPAWN_TOOL = `mcp__${PLUGIN}__spawn_helper`

/** How often the panel re-reads the agents. */
export const POLL_MS = 2000
/** How long `progress` waits for new main-chat activity: under the 10 s hook budget. */
export const PROGRESS_WAIT_MS = 7000
export const MAX_RUNNING_HELPERS = 3
/** Finished agents kept on the panel. */
export const KEEP_FINISHED = 12
const RESULT_CHARS = 4000

export const TERMINAL = new Set(['completed', 'failed', 'killed'])

/** What a helper may call: reading, searching and running checks; never an edit or a further agent. */
export const HELPER_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch']

export type MainEvent = { seq: number; text: string }

export const WATCHER_SYSTEM = `You are the session-boost watcher. The person's main Claude Code chat is in the middle of a task. You follow its progress and launch read-only helper subagents that make it faster or better. You never edit files and never talk to the person.

Loop:
1. Call ${PROGRESS_TOOL}. It waits a few seconds for new activity and returns what the main chat did since your last call, the helpers' status and results, and whether to stop.
2. Decide whether a helper is a clear win: independent work the main chat will need soon that can run in parallel, such as finding every call site or usage, running the test suite or build and reporting failures, reviewing the changes made so far for bugs, or reading docs/code the main chat is about to need. Never launch a helper that duplicates what the main chat or another helper is already doing. When in doubt, don't.
3. To launch one, call ${SPAWN_TOOL} with a short description and a complete, self-contained prompt (the helper sees nothing of the conversation): name files, symbols and commands, and say what to report. Helpers are read-only.
4. Go back to 1. Stop (end your turn with a one-line summary) as soon as ${PROGRESS_TOOL} returns stop: true.

Helpers' results are delivered to the main chat automatically; do not relay them.`

export const HELPER_SYSTEM = `You are a read-only helper launched by session-boost to speed up the person's main Claude Code chat, which is working in this repository at the same time.

- Never modify anything: no file edits or writes, no git commits, checkouts, stashes or resets, no installs, no commands that write to the working tree. Reading files, searching, and running tests, builds, linters or type-checkers that don't write to the repo are fine.
- Do exactly the task you were given, then stop.
- Your final message is delivered to the main chat as-is: lead with the answer, cite file:line for every claim about code, mark anything you could not confirm, and keep it under 300 words.`

/** One line for a tool call: the tool and its most telling argument. */
export function summarizeCall(tool: string, input: Record<string, unknown>): string {
  for (const key of ['description', 'file_path', 'path', 'pattern', 'command', 'url', 'query', 'prompt']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') return `${tool} ${oneLine(value, 80)}`
  }

  return tool
}

/** What an agent is doing now, from its transcript: its in-flight tool call, else its last text. */
export function describeActivity(messages: readonly SessionMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.role !== 'assistant') continue
    const open = message.toolUses.findLast(use => use.result === undefined && use.text === undefined)
    if (open) return `▸ ${summarizeCall(open.tool, open.input)}`
    const last = message.toolUses.at(-1)
    if (message.text.trim() !== '') return oneLine(message.text, 120)
    if (last) return `✓ ${summarizeCall(last.tool, last.input)}`
  }

  return 'starting…'
}

/** The agent's final answer: its last assistant text. */
export function finalAnswer(messages: readonly SessionMessage[]): string {
  const last = messages.findLast(m => m.role === 'assistant' && m.text.trim() !== '')
  const text = last?.text.trim() ?? '(no answer)'

  return text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}…` : text
}

/** The main chat so far, for the watcher's opening prompt. */
export function mainDigest(messages: readonly SessionMessage[], rows = 12): string {
  return messages
    .slice(-rows)
    .map(m => {
      const calls = m.toolUses.map(use => `  - ${summarizeCall(use.tool, use.input)}`).join('\n')
      const text = m.text.trim() === '' ? '' : oneLine(m.text, 600)
      return `${m.role === 'user' ? 'User' : 'Assistant'}: ${text}${calls ? `\n${calls}` : ''}`
    })
    .join('\n')
}

export function watcherPrompt(task: string, digest: string): string {
  return [
    'The person just asked to boost the task their main chat is working on.',
    '',
    '<task>',
    task || '(the turn started without a typed prompt; infer the task from the conversation)',
    '</task>',
    '',
    '<conversation_so_far>',
    digest || '(nothing yet)',
    '</conversation_so_far>',
    '',
    `Start your loop by calling ${PROGRESS_TOOL}.`,
  ].join('\n')
}

export function helperDelivery(description: string, answer: string, isFailed: boolean): string {
  return [
    `[session-boost] A read-only helper ${isFailed ? 'failed' : 'finished'}: ${description}.`,
    'Use what helps the current task; ignore it otherwise.',
    '',
    answer,
  ].join('\n')
}

export function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** A model the panel can suggest: its tier (what jobs it suits) and its price, $ per MTok. */
export type ModelOption = { id: string; label: string; tier: number; input: number; output: number }

/**
 * The current generation, most capable first (prices as of 2026-10-06; older models of each
 * family cost the same or more, so they are never the cheaper suggestion).
 * Tier: 3 = hardest reasoning and design, 2 = everyday coding, 1 = search, lookup and summaries.
 */
export const MODELS: readonly ModelOption[] = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1', tier: 4, input: 10, output: 50 },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', tier: 3, input: 4, output: 20 },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', tier: 2, input: 2, output: 10 },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', tier: 1, input: 0.1, output: 0.5 },
]

/** Prices of the families' older models, so a parent on one of them still compares right. */
const OLDER: Record<string, { input: number; output: number }> = {
  'fable-5': { input: 10, output: 50 },
  'mythos-5': { input: 10, output: 50 },
  'opus-5': { input: 5, output: 25 },
  'opus-4': { input: 5, output: 25 },
  'sonnet-5': { input: 2, output: 10 },
  'sonnet-4': { input: 3, output: 15 },
  'haiku-4': { input: 1, output: 5 },
}

/** A model name as the session or a spawn spells it (`claude-opus-5-5`, `opus`, `Opus 5.5 (1M)`) to its price. */
export function priceOf(name: string | undefined): { input: number; output: number } | undefined {
  if (!name) return undefined
  const lower = name.toLowerCase()
  const family = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'].find(f => lower.includes(f))
  if (!family) return undefined
  const current = MODELS.find(m => m.id.includes(family === 'mythos' ? 'fable' : family))
  const version = /(\d+)(?:[-.](\d+))?/.exec(lower.slice(lower.indexOf(family)))
  if (!version) return current
  const exact = MODELS.find(m => m.id === `claude-${family}-${version[1]}${version[2] ? `-${version[2]}` : ''}`)

  return exact ?? OLDER[`${family}-${version[1]}`] ?? current
}

/** A blended $ per MTok, output weighted as agents write about a third as much as they read. */
function cost(price: { input: number; output: number }): number {
  return price.input * 0.75 + price.output * 0.25
}

const LOOKUP_TYPES = new Set(['explore', 'claude-code-guide', 'statusline-setup'])
const REASONING_TYPES = new Set(['plan'])
const REASONING_WORDS = /\b(review|design|architect|plan|diagnos|debug|security|audit|root cause|trade-?off|refactor)/i
const LOOKUP_WORDS = /\b(find|search|locate|list|look ?up|check|docs?|research|read|summar|verify|where)/i
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

/** What kind of job a subagent does: by its type, its description, then the tools it has used. */
export function classifyJob(type: string, description: string, tools: readonly string[]): 'lookup' | 'coding' | 'reasoning' {
  const kind = type.toLowerCase()
  if (REASONING_TYPES.has(kind) || REASONING_WORDS.test(description)) return 'reasoning'
  if (tools.some(tool => WRITE_TOOLS.has(tool))) return 'coding'
  if (LOOKUP_TYPES.has(kind) || LOOKUP_WORDS.test(description)) return 'lookup'
  if (tools.length > 0 && tools.every(tool => /^(Read|Grep|Glob|WebFetch|WebSearch|ToolSearch|mcp__)/.test(tool))) return 'lookup'

  return 'coding'
}

const NEEDED_TIER = { lookup: 1, coding: 2, reasoning: 3 } as const

/** Models that suit the job and cost less than the chat's model, most capable first. */
export function cheaperModels(parentModel: string | undefined, job: 'lookup' | 'coding' | 'reasoning'): ModelOption[] {
  const parent = priceOf(parentModel)
  if (!parent) return []

  return MODELS.filter(m => m.tier >= NEEDED_TIER[job] && cost(m) < cost(parent))
}

/** "Sonnet 5.5 ($2/$10, 50% less)": what the panel shows for one suggestion. */
export function describeOption(option: ModelOption, parentModel: string | undefined): string {
  const parent = priceOf(parentModel)
  const saving = parent ? Math.round((1 - cost(option) / cost(parent)) * 100) : undefined
  const money = (n: number) => (n < 1 ? `$${n.toFixed(2)}` : `$${n}`)

  return `${option.label} (${money(option.input)}/${money(option.output)}${saving === undefined ? '' : `, ${saving}% less`})`
}

/** How often the overspend cue flips between highlighted and plain. */
export const BLINK_MS = 500

/**
 * The model to suggest instead of the one a subagent runs on: the cheapest that suits its job
 * and costs less. Undefined when it already runs on the cheapest capable model (or the price is unknown).
 */
export function recommendedModel(runsOn: string | undefined, job: 'lookup' | 'coding' | 'reasoning'): ModelOption | undefined {
  return cheaperModels(runsOn, job).at(-1)
}

export type Job = 'lookup' | 'coding' | 'reasoning'

/** What a spawn can be told apart by before it runs: its type and the job its description reads as. */
export function spawnKind(type: string, description: string): { key: string; job: Job; label: string } {
  const job = classifyJob(type, description, [])

  return { key: `${type}:${job}`, job, label: `${type} ${job} jobs` }
}

/** The more demanding of two jobs. */
export function harderJob(a: Job, b: Job): Job {
  return NEEDED_TIER[a] >= NEEDED_TIER[b] ? a : b
}

/** The cheaper of two models (the first when a price is unknown). */
export function cheaperOf(a: string, b: string): string {
  const pa = priceOf(a)
  const pb = priceOf(b)

  return pa && pb && cost(pb) < cost(pa) ? b : a
}
