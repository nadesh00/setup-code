import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, Boost, HelperRow, Suggestion } from '../types'
import {
  BLINK_MS, cheaperOf, classifyJob, describeActivity, describeOption, harderJob, finalAnswer, HELPER_SYSTEM, HELPER_TOOLS, HELPER_TYPE, helperDelivery, KEEP_FINISHED,
  mainDigest, type MainEvent, MAX_RUNNING_HELPERS, oneLine, PANE, POLL_MS, PROGRESS_TOOL, PROGRESS_WAIT_MS,
  SPAWN_TOOL, spawnKind, summarizeCall, recommendedModel, TERMINAL, WATCHER_SYSTEM, WATCHER_TYPE, watcherPrompt,
} from './core'

const OFF: Boost = { status: 'off', watcherId: null, helpers: [] }

const agents = atom({ plugin: 'session-boost', key: 'agents' } as const, [])
const boost = atom({ plugin: 'session-boost', key: 'boost' } as const, OFF)
/** Each subagent's model as its spawn resolved it, by agent id. */
const models = atom({ plugin: 'session-boost', key: 'models' } as const, {})
/** The overspend cue's phase: flipped every BLINK_MS while a live row has one. */
const blink = atom({ plugin: 'session-boost', key: 'blink' } as const, false)
/** The person's picks, by spawn kind (`Explore:lookup`) → model id; mirrored in the store across sessions. */
const prefs = atom({ plugin: 'session-boost', key: 'prefs' } as const, {})

type HelperTask = { key: string; description: string; prompt: string }

/** What this module has seen since it loaded; a reload starts it over. */
type Live = {
  /** The main chat's turn. */
  main: { isActive: boolean; text: string }
  events: MainEvent[]
  /** The first event the watcher has not been given yet. */
  cursor: number
  waiters: Array<() => void>
  /** Helpers the watcher asked for, waiting for a running seat. */
  queue: HelperTask[]
  /** Agents already read once finished: their transcripts are not read again. */
  settled: Set<string>
  isPolling: boolean
  tasks: number
  /** Helpers whose answer reached the main chat: delivered once, by turn.complete or the poll. */
  delivered: Set<string>
  /** Polls in a row a helper was seen ended without its turn.complete, or the watcher not listed. */
  strikes: Map<string, number>
}

function wake(live: Live) {
  const ready = live.waiters
  live.waiters = []
  for (const resolve of ready) resolve()
}

/** The seq the next main-chat event gets. */
function nextSeq(live: Live): number {
  return (live.events.at(-1)?.seq ?? -1) + 1
}

function record(live: Live, text: string) {
  live.events = [...live.events, { seq: nextSeq(live), text }].slice(-200)
  wake(live)
}

export const register: Register = on => {
  const live: Live = {
    main: { isActive: false, text: '' },
    events: [],
    cursor: 0,
    waiters: [],
    queue: [],
    settled: new Set(),
    isPolling: false,
    tasks: 0,
    delivered: new Set(),
    strikes: new Map(),
  }

  on('session.start', async ($, e, next) => {
    const saved = (await $.store.get('prefs').catch(() => undefined)) as Record<string, string> | undefined
    if (saved) await update($, prefs, () => saved)
    await Promise.all([
      $.command.register({ name: 'subagents', description: 'Show every subagent live in a side panel', immediate: true }),
      $.command.register({
        name: 'boost',
        description: 'Start a watcher that launches read-only helper subagents for the turn in progress',
        argumentHint: '[stop]',
        immediate: true,
      }),
      $.tool.register({
        name: 'progress',
        description: 'session-boost watcher only: waits briefly for new activity in the main chat, then returns it with the helpers\' status and results, and whether to stop.',
        inputSchema: { type: 'object', properties: {} },
        isDeferred: false,
      }),
      $.tool.register({
        name: 'spawn_helper',
        description: `session-boost watcher only: launches a read-only helper subagent (at most ${MAX_RUNNING_HELPERS} run at once; more are queued).`,
        inputSchema: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'A few words naming the task' },
            prompt: { type: 'string', description: 'The complete, self-contained task for the helper' },
          },
          required: ['description', 'prompt'],
        },
        isDeferred: false,
      }),
      $.agent.register({
        name: 'watcher',
        description: 'session-boost watcher (started by /boost only)',
        prompt: WATCHER_SYSTEM,
        tools: [PROGRESS_TOOL, SPAWN_TOOL, 'Read', 'Grep', 'Glob'],
      }),
      $.agent.register({
        name: 'helper',
        description: 'session-boost read-only helper (started by the watcher only)',
        prompt: HELPER_SYSTEM,
        tools: HELPER_TOOLS,
      }),
    ])
    // All background work (the panel, launching helpers) runs from this timer on the session's
    // own $, so no hook steps past a helper and no helper is a child of the watcher.
    $.clock.every(POLL_MS, () => void poll($, live))
    $.clock.every(BLINK_MS, () => void flip($))
    if (e.isInteractive) void $.ui.open({ id: PANE, title: 'Subagents' })

    return next(e)
  })

  // Every subagent runs on the chat's own model unless its caller named one: an agent
  // definition's pinned model (a built-in's `haiku`, say) never decides it.
  on('agent.spawn', async ($, e, next) => {
    const isPinnable = !e.fork && e.workflow === undefined
    // The person's pick for this kind of subagent, never pricier than the chat's own.
    const picked = (await read($, prefs))[spawnKind(e.subagentType, e.description).key]
    const asked = e.model ?? (isPinnable ? (picked ? cheaperOf(e.parentModel, picked) : e.parentModel) : undefined)
    const result = await next(asked === e.model ? e : { ...e, model: asked })
    const model = result.deny === undefined ? (result.model || asked) : undefined
    if (result.agentId !== undefined && model) {
      const agentId = result.agentId
      await update($, models, (m): Record<string, string> => ({ ...m, [agentId]: model }))
    }

    return result
  }).catch(($, e, next) => next(e)) // a failing hook never blocks a spawn

  // The two agent types are the mod's own: the main model never delegates to them.
  on('agent.offer', { agent: 'session-boost:watcher' }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))
  on('agent.offer', { agent: 'session-boost:helper' }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))

  on('turn.start', async ($, e, next) => {
    // A continuation turn has no text of its own: the task is still the last one typed.
    live.main = { isActive: true, text: e.text || live.main.text }
    record(live, `Main turn started${e.text ? `: ${oneLine(e.text, 200)}` : ''}`)

    return next(e)
  })

  // Every loop's end: the main turn's, the watcher's, a helper's (its answer is its turn.complete).
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      live.main = { ...live.main, isActive: false }
      record(live, 'Main turn ended')
      return next(e)
    }
    const state = await read($, boost)
    const helper = state.helpers.find(h => h.id === e.agentId)
    if (helper?.status === 'running') await settleHelper($, live, helper, e.answer, e.reason !== 'answer')
    if (e.agentId === state.watcherId && state.status !== 'off') {
      live.queue = []
      await update($, boost, (b): Boost => ({ ...b, status: 'stopping', helpers: b.helpers.filter(h => h.status !== 'queued') }))
    }

    return next(e)
  })

  // The main chat's progress, as the watcher reads it.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || e.tool === PROGRESS_TOOL || e.tool === SPAWN_TOOL) return next(e)
    const call = summarizeCall(e.tool, e as unknown as Record<string, unknown>)
    record(live, `Main chat started ${call}`)
    const result = await next(e)
    if ('deny' in result && result.deny !== undefined) record(live, `Main chat's ${call} was denied`)
    else if ('isError' in result && result.isError) record(live, `Main chat's ${call} failed`)

    return result
  }).catch(($, e, next) => next(e)) // a failing recorder never blocks the main chat's tool

  on('command.run', { command: 'subagents' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Subagents' })

    return { text: opened.isPlaced ? 'Subagents panel opened.' : `Subagents panel waits: ${opened.reason}` }
  })

  on('command.run', { command: 'boost' }, async ($, e) => {
    const state = await read($, boost)
    if (e.args.trim() === 'stop') {
      if (state.status === 'off') return { text: 'No boost is running.' }
      live.queue = []
      await update($, boost, (b): Boost => ({ ...b, status: 'stopping', helpers: b.helpers.filter(h => h.status !== 'queued') }))
      wake(live)
      return { text: 'Boost stopping: the watcher ends at its next check; running helpers finish and report.' }
    }
    if (state.status !== 'off') return { text: 'Boost is already running. /boost stop ends it.' }
    if (!live.main.isActive) return { text: 'Nothing in progress to boost: run /boost while a turn is working.' }

    // Claimed before the spawn: a second /boost waits it out, and the watcher's first call is let in.
    await update($, boost, (): Boost => ({ ...OFF, status: 'starting' }))
    // No model named: the agent.spawn hook puts it on the chat's own (`$.agent.spawn` takes only aliases).
    const messages = await $.session.messages()
    live.cursor = nextSeq(live)
    const spawned = await $.agent.spawn({
      subagentType: WATCHER_TYPE,
      description: 'Boost watcher',
      prompt: watcherPrompt(live.main.text, mainDigest(messages)),
    })
    if (spawned.deny !== undefined || spawned.agentId === undefined) {
      await update($, boost, () => OFF)
      return { text: `Could not start the boost watcher: ${spawned.deny ?? 'no agent started'}` }
    }
    const watcherId = spawned.agentId
    await update($, boost, (b): Boost => ({ ...b, status: b.status === 'starting' ? 'watching' : b.status, watcherId }))
    void $.ui.open({ id: PANE, title: 'Subagents' })

    return { text: 'Boost started: a watcher follows this turn and launches read-only helpers. /boost stop ends it.' }
  })

  on('tool.call', { tool: 'mcp__session-boost__progress' }, async ($, e) => {
    if (!(await isWatcher($, e.agentId))) return { deny: 'Only the session-boost watcher calls this tool.' }
    const state = await read($, boost)
    if (state.status !== 'stopping' && live.main.isActive && live.cursor >= nextSeq(live)) {
      await new Promise<void>(resolve => {
        const done = () => {
          live.waiters = live.waiters.filter(waiter => waiter !== early)
          resolve()
        }
        const timer = $.clock.after(PROGRESS_WAIT_MS, done)
        const early = () => {
          timer.cancel()
          resolve()
        }
        live.waiters.push(early)
      })
    }
    const fresh = live.events.filter(event => event.seq >= live.cursor).map(event => event.text)
    live.cursor = nextSeq(live)
    const now = await read($, boost)
    const stop = now.status === 'stopping' || now.status === 'off' || !live.main.isActive

    return {
      result: {
        stop,
        ...(stop ? { reason: live.main.isActive ? 'The person stopped the boost.' : 'The main turn ended.' } : {}),
        mainChat: fresh.length > 0 ? fresh : ['(no new activity)'],
        helpers: now.helpers.map(({ description, status }) => ({ description, status })),
        runningLimit: MAX_RUNNING_HELPERS,
      },
    }
  }).catch(() => ({ result: { stop: false, mainChat: ['(progress check failed; call again)'], helpers: [] } }))

  on('tool.call', { tool: 'mcp__session-boost__spawn_helper' }, async ($, e) => {
    if (!(await isWatcher($, e.agentId))) return { deny: 'Only the session-boost watcher calls this tool.' }
    const state = await read($, boost)
    if (state.status === 'stopping' || state.status === 'off') return { deny: 'The boost is stopping: no new helpers.' }
    const input = e as unknown as Record<string, unknown>
    live.tasks += 1
    const task: HelperTask = {
      key: `h${live.tasks}`,
      description: String(input.description ?? 'helper'),
      prompt: String(input.prompt ?? ''),
    }
    if (task.prompt.trim() === '') return { deny: 'A helper needs a prompt.' }
    // The row first, then the queue: a poll never takes a task whose row is not there yet.
    await update($, boost, (b): Boost => ({ ...b, helpers: [...b.helpers, { key: task.key, description: task.description, status: 'queued' }] }))
    live.queue.push(task)
    // Seats ahead of this one: the running and the already queued.
    const ahead = state.helpers.filter(h => h.status === 'running' || h.status === 'queued').length
    // The next poll launches it, on the session's own $, never this hook's.

    return { result: { status: ahead < MAX_RUNNING_HELPERS ? 'starting' : 'queued', description: task.description } }
  }).catch(() => ({ deny: 'spawn_helper failed; try again or carry on without it.' }))

  on('ui.render', { component: 'Pane', requestId: 'subagents' }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [rows, state, isLit, picks] = await Promise.all([read($, agents), read($, boost), read($, blink), read($, prefs)])
    const helpers = state.helpers
    const count = (status: HelperRow['status']) => helpers.filter(h => h.status === status).length

    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        {state.status !== 'off' && (
          <Box marginBottom={1}>
            <Text color="magenta" wrap="truncate-end">
              Boost {state.status}: {count('running')} running, {count('queued')} queued, {count('done')} done
              {count('failed') > 0 ? `, ${count('failed')} failed` : ''}
            </Text>
          </Box>
        )}
        {rows.length === 0 && <Text dimColor>No subagents yet.</Text>}
        {rows.map(row => {
          const isLive = !TERMINAL.has(row.status)
          const mark = row.status === 'completed' ? '✓' : TERMINAL.has(row.status) ? '✗' : row.status === 'running' ? '●' : '○'
          const indent = row.parentId ? '  ' : ''
          const suggestion = row.suggestion
          const isPicked = suggestion !== undefined && picks[suggestion.kind] === suggestion.id
          return (
            <Box key={row.id} flexDirection="column" marginBottom={1}>
              <Box flexDirection="row">
                <Box flexGrow={1} flexShrink={1}>
                  <Text bold={isLive} dimColor={!isLive} wrap="truncate-end">
                    {indent}{mark} {row.description}
                    <Text dimColor>{` ${row.type}${row.role ? ` [${row.role}]` : ''}${row.model ? ` · ${row.model}` : ''}`}</Text>
                  </Text>
                </Box>
                {suggestion && (
                  <Button key={`use-${row.id}`} onPress={() => togglePick($, suggestion)}>
                    {/* Blinks while the subagent runs and nothing is picked yet (highlight on and off, same width). */}
                    <Text color={isPicked ? 'green' : 'yellow'} bold inverse={!isPicked && isLive && isLit}>
                      {isPicked ? ` ✓ ${suggestion.label} ` : ` ▲ use ${suggestion.label} `}
                    </Text>
                  </Button>
                )}
              </Box>
              <Text dimColor wrap="truncate-end">
                {indent}{'  '}{row.activity}
              </Text>
              {row.job && (
                <Text color={suggestion && !isPicked ? 'green' : undefined} dimColor={!suggestion || isPicked} wrap="truncate-end">
                  {indent}{'  '}
                  {!suggestion
                    ? `${row.job} job · already on the cheapest model that suits it`
                    : isPicked
                      ? `${row.job} job · future ${suggestion.kindLabel} start on ${suggestion.label} · click ✓ to undo`
                      : `${row.job} job · ${suggestion.label} costs ${suggestion.detail} · click ▲ to start future ${suggestion.kindLabel} on it`}
                </Text>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}

/** The watcher's own calls: by id once known, by type while its spawn is still resolving. */
async function isWatcher($: EngineInterface, agentId: string | undefined): Promise<boolean> {
  if (agentId === undefined) return false
  const state = await read($, boost)
  if (state.watcherId === agentId) return true
  if (state.status !== 'starting') return false
  const listed = await $.agent.list()

  return listed.some(agent => agent.id === agentId && agent.type === WATCHER_TYPE)
}

/** Re-reads every agent for the panel and fills free helper seats. */
async function poll($: EngineInterface, live: Live) {
  if (live.isPolling) return
  live.isPolling = true
  try {
    const [listed, parentModel, spawnedOn] = await Promise.all([$.agent.list(), $.session.model(), read($, models)])
    const state = await read($, boost)
    const before = await read($, agents)
    const old = new Map(before.map(row => [row.id, row]))
    const helperIds = new Set(state.helpers.flatMap(h => (h.id ? [h.id] : [])))

    const rows: AgentRow[] = []
    for (const agent of listed) {
      const was = old.get(agent.id)
      const isLive = !TERMINAL.has(agent.status)
      let activity = was?.activity ?? 'starting…'
      let job = was?.job
      if (isLive || !live.settled.has(agent.id)) {
        const found = await $.session.messages({ agentId: agent.id })
        if (Array.isArray(found)) {
          activity = isLive ? describeActivity(found) : `${agent.status}: ${oneLine(finalAnswer(found), 120)}`
          const tools = found.flatMap(message => message.toolUses.map(use => use.tool))
          job = classifyJob(agent.type, agent.description, tools)
        }
        if (!isLive) live.settled.add(agent.id)
      }
      job ??= classifyJob(agent.type, agent.description, [])
      const model = spawnedOn[agent.id]
      // One suggestion: the cheapest model that suits both what it does and what its kind's spawns
      // read as (so a pick never puts future harder jobs on too weak a model), below what it runs on
      // (one spawned before the mod loaded is taken to run on the chat's).
      const kind = spawnKind(agent.type, agent.description)
      const runsOn = model ?? parentModel
      const option = recommendedModel(runsOn, harderJob(job, kind.job))
      const suggestion: Suggestion | undefined = option && {
        id: option.id,
        label: option.label,
        detail: describeOption(option, runsOn).replace(/^[^(]*\(|\)$/g, ''),
        kind: kind.key,
        kindLabel: kind.label,
      }
      const role = agent.id === state.watcherId ? 'watcher' : helperIds.has(agent.id) ? 'helper' : undefined
      rows.push({
        id: agent.id,
        description: agent.description,
        type: agent.type,
        status: agent.status,
        activity,
        ...(agent.parentId ? { parentId: agent.parentId } : {}),
        ...(role ? { role } : {}),
        ...(model ? { model } : {}),
        job,
        ...(suggestion ? { suggestion } : {}),
      })
    }

    const active = rows.filter(row => !TERMINAL.has(row.status))
    const done = rows.filter(row => TERMINAL.has(row.status)).slice(-KEEP_FINISHED)
    const next = [...active, ...done]
    if (JSON.stringify(next) !== JSON.stringify(before)) await update($, agents, () => next)

    // A helper ended (killed, say) with no turn.complete: after a second look, the poll settles it.
    for (const helper of state.helpers) {
      if (helper.status !== 'running' || helper.id === undefined) continue
      const agent = listed.find(one => one.id === helper.id)
      if (agent !== undefined && !TERMINAL.has(agent.status)) {
        live.strikes.delete(helper.id)
        continue
      }
      if (strike(live, helper.id) < 2) continue
      const found = await $.session.messages({ agentId: helper.id })
      const answer = Array.isArray(found) ? finalAnswer(found) : ''
      await settleHelper($, live, helper, answer, agent?.status !== 'completed')
    }

    await fillSeats($, live)

    // The boost is over once the watcher has ended (or gone unlisted twice) and no helper is left.
    const after = await read($, boost)
    const watcher = after.watcherId === null ? undefined : listed.find(agent => agent.id === after.watcherId)
    if (after.watcherId !== null && watcher !== undefined) live.strikes.delete(after.watcherId)
    const isWatcherGone =
      after.watcherId !== null &&
      (watcher === undefined ? strike(live, after.watcherId) >= 2 : TERMINAL.has(watcher.status))
    if (isWatcherGone && after.status === 'watching') {
      live.queue = []
      await update($, boost, (b): Boost => ({ ...b, status: 'stopping', helpers: b.helpers.filter(h => h.status !== 'queued') }))
    }
    const settled = await read($, boost)
    const isHelping = settled.helpers.some(h => h.status === 'running' || h.status === 'queued')
    if (settled.status === 'stopping' && !isHelping && (settled.watcherId === null || isWatcherGone)) {
      await update($, boost, () => OFF)
    }
  } finally {
    live.isPolling = false
  }
}

function strike(live: Live, id: string): number {
  const count = (live.strikes.get(id) ?? 0) + 1
  live.strikes.set(id, count)

  return count
}

/** A helper's end: its row marked, its answer handed to the main chat, once. */
async function settleHelper($: EngineInterface, live: Live, helper: HelperRow, answer: string, isFailed: boolean) {
  if (helper.id === undefined || live.delivered.has(helper.id)) return
  live.delivered.add(helper.id)
  live.strikes.delete(helper.id)
  await update($, boost, (b): Boost => ({
    ...b,
    helpers: b.helpers.map(h => (h.key === helper.key ? { ...h, status: isFailed ? 'failed' : 'done' } : h)),
  }))
  const text = helperDelivery(helper.description, answer.trim() === '' ? '(no answer)' : answer.trim(), isFailed)
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => undefined)
  $.ui.toast(`Boost helper ${isFailed ? 'failed' : 'finished'}: ${helper.description}`)
  wake(live)
}

/** A click on a row's suggestion: future subagents of its kind start on that model; a second click undoes it. */
async function togglePick($: EngineInterface, suggestion: Suggestion) {
  const next = await update($, prefs, (picks): Record<string, string> => {
    const { [suggestion.kind]: current, ...rest } = picks
    return current === suggestion.id ? rest : { ...rest, [suggestion.kind]: suggestion.id }
  })
  await $.store.set('prefs', next)
  $.ui.toast(
    next[suggestion.kind] === suggestion.id
      ? `Future ${suggestion.kindLabel} will start on ${suggestion.label}`
      : `Future ${suggestion.kindLabel} follow the chat's model again`,
  )
}

/** Flips the overspend cue's phase, only while some live row shows one (no redraws otherwise). */
async function flip($: EngineInterface) {
  const [rows, picks] = await Promise.all([read($, agents), read($, prefs)])
  const isNeeded = rows.some(
    row => row.suggestion !== undefined && picks[row.suggestion.kind] !== row.suggestion.id && !TERMINAL.has(row.status),
  )
  const isLit = await read($, blink)
  if (isNeeded || isLit) await update($, blink, () => isNeeded && !isLit)
}

async function fillSeats($: EngineInterface, live: Live) {
  const state = await read($, boost)
  if (state.status !== 'watching' && state.status !== 'starting') return
  let running = state.helpers.filter(h => h.status === 'running').length
  while (running < MAX_RUNNING_HELPERS && live.queue.length > 0) {
    const task = live.queue.shift() as HelperTask
    const spawned = await $.agent.spawn({
      subagentType: HELPER_TYPE,
      description: task.description,
      prompt: task.prompt,
    })
    const started: HelperRow =
      spawned.deny === undefined && spawned.agentId !== undefined
        ? { key: task.key, id: spawned.agentId, description: task.description, status: 'running' }
        : { key: task.key, description: task.description, status: 'failed' }
    // By key, and kept even if a stop cleared the queued row meanwhile: a started helper is always tracked.
    await update($, boost, (b): Boost => ({
      ...b,
      helpers: b.helpers.some(h => h.key === task.key)
        ? b.helpers.map(h => (h.key === task.key ? started : h))
        : [...b.helpers, started],
    }))
    if (started.status === 'running') running += 1
  }
}
