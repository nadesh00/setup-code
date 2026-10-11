import type { AgentInfo, AgentSpawnInput, On, SessionMessage } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'

const MODEL = 'claude-opus-5-5'
const PROGRESS = 'mcp__session-boost__progress'
const SPAWN = 'mcp__session-boost__spawn_helper'

/** The engine beneath the plugin: agents, transcripts, spawns, appends and toasts, all mutable by the test. */
function world(on: On, stored: Record<string, unknown> = {}) {
  const w = {
    agents: [] as AgentInfo[],
    transcripts: new Map<string, SessionMessage[]>(),
    spawns: [] as AgentSpawnInput[],
    toasts: [] as string[],
    opens: 0,
    nextIds: ['w1', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    /** Runs inside the spawn hook before it answers: the started agent acting before its spawn resolves. */
    beforeSpawnAnswer: undefined as ((agentId: string) => Promise<void>) | undefined,
    clock: mock.clock(on),
    session: mock.session(on),
    /** The plugin's store, across sessions: readable by the test. */
    stored: { ...stored } as Record<string, unknown>,
  }
  on('store.get', async (_$, e) => ({ value: w.stored[e.key] }))
  on('store.set', async (_$, e) => {
    w.stored[e.key] = e.value
    return { value: undefined }
  })
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', async (_$, e) => ({ value: { tool: e.name } }))
  on('agent.register', async (_$, e) => ({ value: { agent: e.name } }))
  on('ui.open', async () => {
    w.opens += 1
    return { value: { isPlaced: true as const } }
  })
  on('ui.toast', async (_$, e) => {
    w.toasts.push(typeof e === 'string' ? e : (e as { text: string }).text)
    return { value: undefined }
  })
  on('session.model', async () => ({ value: MODEL }))
  on('session.messages', async (_$, e) => {
    const id = (e as { agentId?: string } | undefined)?.agentId
    return { value: id === undefined ? [] : (w.transcripts.get(id) ?? []) }
  })
  on('agent.list', async () => ({ value: w.agents }))
  // A plugin's $.agent.spawn reaches this hook in the Agent tool's shape (subagent_type, run_in_background),
  // and the kit reads the started id from the tool record (`result.agentId`), so both are given.
  on('agent.spawn', async (_$, e) => {
    const raw = e as unknown as Record<string, unknown>
    w.spawns.push({ ...e, subagentType: e.subagentType ?? (raw.subagent_type as string | undefined) })
    const agentId = w.nextIds.shift() as string
    await w.beforeSpawnAnswer?.(agentId)
    return { model: e.model ?? MODEL, agentId, result: { agentId } } as never
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('tool.call', async () => ({ result: 'ok' }) as never)

  return w
}

type World = ReturnType<typeof world>

const helperSpawns = (w: World) => w.spawns.filter(s => s.subagentType === 'session-boost:helper')

async function start($: Engine, isInteractive = true) {
  await $.session.start({ cwd: '/repo', surface: isInteractive ? 'terminal' : null, isInteractive })
}

const boostCmd = (args = '') =>
  ({ command: 'boost', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as never

const turnComplete = (extra: Record<string, unknown> = {}) =>
  ({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer', ...extra }) as never

/** A call of one of the mod's tools, by the watcher (w1) unless another caller is named; null is the main chat. */
const call = (tool: string, input: Record<string, unknown> = {}, agentId: string | null = 'w1') =>
  ({ tool, ...input, ...(agentId === null ? {} : { agentId }) }) as never

async function mountPane($: Engine) {
  return $.ui.mount({
    plugin: 'session-boost',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'subagents',
    viewport: { columns: 160, rows: 40, isFullscreen: true },
    props: { title: 'Subagents', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  } as never)
}

/** Session started, a main turn running, /boost started the watcher w1 (listed as running). */
async function boosted($: Engine, on: On) {
  const w = world(on)
  await start($)
  await $.turn.start({ text: 'fix the bug', turnId: 't1' })
  const result = await $.command.run(boostCmd())
  expect(result).toMatchObject({ text: expect.stringContaining('Boost started') })
  w.agents = [{ id: 'w1', description: 'Boost watcher', type: 'session-boost:watcher', status: 'running' }]
  await w.clock.settle()
  return w
}

test('panel shows a running agent live, then its finish', async ($, on) => {
  const w = world(on)
  w.agents = [{ id: 'a1', description: 'Find call sites', type: 'Explore', status: 'running' }]
  w.transcripts.set('a1', [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Grep', input: { pattern: 'callSite' } }] },
  ])
  await start($)
  await w.clock.advance(2000)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /● Find call sites/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▸ Grep callSite/ })).toBeDefined()

  w.agents = [{ id: 'a1', description: 'Find call sites', type: 'Explore', status: 'completed' }]
  w.transcripts.set('a1', [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Grep', input: { pattern: 'callSite' }, text: 'hits' }] },
    { role: 'assistant', text: 'Three call sites: a.ts:1, b.ts:2, c.ts:3', toolUses: [] },
  ])
  await w.clock.advance(2000)

  expect(await ui.find({ type: 'Text', text: /✓ Find call sites/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /completed: Three call sites/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▸ Grep/ })).toBeUndefined()
})

test('the pane opens at start only in an interactive session', async ($, on) => {
  const w = world(on)
  await start($, false)
  await w.clock.settle()
  expect(w.opens).toBe(0)
})

test('/boost with no turn running answers "Nothing in progress" and spawns nothing', async ($, on) => {
  const w = world(on)
  await start($)
  const result = await $.command.run(boostCmd())
  expect(result).toMatchObject({ text: expect.stringContaining('Nothing in progress') })
  await w.clock.advance(2000)
  expect(w.spawns).toHaveLength(0)
})

test('/boost during a turn spawns the watcher, naming no model of its own', async ($, on) => {
  const w = await boosted($, on)
  expect(w.spawns).toHaveLength(1)
  expect(w.spawns[0]?.subagentType).toBe('session-boost:watcher')
  // The mod names no model (`$.agent.spawn` takes aliases only); its agent.spawn hook puts the
  // spawn on the chat's model from the engine's parentModel, tested on its own below.
  expect(w.spawns[0]?.model).toBeUndefined()
  expect(w.spawns[0]?.prompt).toContain('<task>\nfix the bug\n</task>')

  const again = await $.command.run(boostCmd())
  expect(again).toMatchObject({ text: expect.stringContaining('already running') })
  expect(w.spawns).toHaveLength(1)
})

test('spawn_helper runs at most 3 helpers, queues the rest, and delivers finished answers', async ($, on) => {
  const w = await boosted($, on)

  for (const n of [1, 2, 3, 4]) {
    const answer = await $.tool.call(call(SPAWN, { description: `task ${n}`, prompt: `do task ${n}` }))
    expect(answer).toMatchObject({ result: { description: `task ${n}` } })
  }
  expect(helperSpawns(w)).toHaveLength(0) // launched by the poll, not the tool call
  await w.clock.advance(2000)

  expect(helperSpawns(w)).toHaveLength(3)
  for (const spawn of helperSpawns(w)) expect(spawn.model).toBeUndefined()
  expect(helperSpawns(w).map(s => s.description)).toEqual(['task 1', 'task 2', 'task 3'])

  // Another poll with nothing finished: still 3.
  w.agents = [
    ...w.agents,
    { id: 'h1', description: 'task 1', type: 'session-boost:helper', status: 'running' },
    { id: 'h2', description: 'task 2', type: 'session-boost:helper', status: 'running' },
    { id: 'h3', description: 'task 3', type: 'session-boost:helper', status: 'running' },
  ]
  await w.clock.advance(2000)
  expect(helperSpawns(w)).toHaveLength(3)
  expect(w.session.appended()).toHaveLength(0)

  // h1 finishes: its answer goes to the main chat and task 4 takes the seat at the next poll.
  w.agents = w.agents.map(a => (a.id === 'h1' ? { ...a, status: 'completed' as const } : a))
  await $.turn.complete(turnComplete({ agentId: 'h1', answer: 'Found it at a.ts:3' }))
  expect(w.session.appended()).toHaveLength(1)
  const text = JSON.stringify(w.session.appended()[0])
  expect(text).toContain('[session-boost]')
  expect(text).toContain('finished: task 1')
  expect(text).toContain('Found it at a.ts:3')
  expect(w.toasts).toContain('Boost helper finished: task 1')

  await w.clock.advance(2000)
  expect(helperSpawns(w)).toHaveLength(4)
  expect(helperSpawns(w)[3]?.description).toBe('task 4')
  expect(helperSpawns(w)[3]?.model).toBeUndefined()

  // Nothing new in the main chat: progress waits its 7 s, then answers with the helpers.
  const pending = $.tool.call(call(PROGRESS))
  await w.clock.advance(7000)
  expect(await pending).toMatchObject({
    result: {
      stop: false,
      helpers: [
        { description: 'task 1', status: 'done' },
        { description: 'task 2', status: 'running' },
        { description: 'task 3', status: 'running' },
        { description: 'task 4', status: 'running' },
      ],
    },
  })
})

test('spawn_helper tells the watcher a call beyond the free seats is queued', async ($, on) => {
  await boosted($, on)
  const statuses: unknown[] = []
  for (const n of [1, 2, 3, 4]) {
    const answer = await $.tool.call(call(SPAWN, { description: `task ${n}`, prompt: `do task ${n}` }))
    statuses.push((answer as { result?: { status?: string } }).result?.status)
  }
  expect(statuses).toEqual(['starting', 'starting', 'starting', 'queued'])
})

test('while the watcher spawn is still resolving, its calls are recognised by its listed type', async ($, on) => {
  const w = world(on)
  const answers: unknown[] = []
  w.beforeSpawnAnswer = async agentId => {
    if (agentId !== 'w1') return
    w.agents = [
      { id: 'w1', description: 'Boost watcher', type: 'session-boost:watcher', status: 'running' },
      { id: 'x9', description: 'other', type: 'Explore', status: 'running' },
    ]
    answers.push(await $.tool.call(call(SPAWN, { description: 'early', prompt: 'p' }, 'w1')))
    answers.push(await $.tool.call(call(SPAWN, { description: 'nope', prompt: 'p' }, 'x9')))
  }
  await start($)
  await $.turn.start({ text: 'fix the bug', turnId: 't1' })
  expect(await $.command.run(boostCmd())).toMatchObject({ text: expect.stringContaining('Boost started') })
  expect(answers[0]).toMatchObject({ result: { description: 'early' } })
  expect(answers[1]).toMatchObject({ deny: expect.stringContaining('Only the session-boost watcher') })
  await w.clock.advance(2000)
  expect(helperSpawns(w).map(s => s.description)).toEqual(['early'])
})

test('a helper ending without an answer is delivered as failed', async ($, on) => {
  const w = await boosted($, on)
  await $.tool.call(call(SPAWN, { description: 'run tests', prompt: 'npm test' }))
  await w.clock.advance(2000)
  expect(helperSpawns(w)).toHaveLength(1)
  await $.turn.complete(turnComplete({ agentId: 'h1', answer: '', reason: 'error' }))
  const text = JSON.stringify(w.session.appended()[0])
  expect(text).toContain('helper failed: run tests')
  expect(text).toContain('(no answer)')
  expect(w.toasts).toContain('Boost helper failed: run tests')
})

test('progress and spawn_helper deny every caller but the watcher', async ($, on) => {
  const w = world(on)
  await start($)
  // No boost yet: even an agent is refused.
  expect(await $.tool.call(call(PROGRESS))).toHaveProperty('deny')

  await $.turn.start({ text: 'fix the bug', turnId: 't1' })
  expect(await $.command.run(boostCmd())).toMatchObject({ text: expect.stringContaining('Boost started') })
  w.agents = [{ id: 'w1', description: 'Boost watcher', type: 'session-boost:watcher', status: 'running' }]
  await w.clock.settle()

  for (const agentId of [null, 'other']) {
    expect(await $.tool.call(call(PROGRESS, {}, agentId))).toMatchObject({
      deny: expect.stringContaining('Only the session-boost watcher'),
    })
    expect(await $.tool.call(call(SPAWN, { description: 'x', prompt: 'y' }, agentId))).toMatchObject({
      deny: expect.stringContaining('Only the session-boost watcher'),
    })
  }
  await w.clock.advance(2000)
  expect(helperSpawns(w)).toHaveLength(0)

  // The watcher itself is let through (so the kit does carry agentId to the hook).
  expect(await $.tool.call(call(SPAWN, { description: 'x', prompt: 'y' }))).not.toHaveProperty('deny')
  await w.clock.advance(2000)
  expect(helperSpawns(w)).toHaveLength(1)
})

test('progress reports main-chat tool calls, then stop once the main turn ends', async ($, on) => {
  const w = await boosted($, on)

  const tool = await $.tool.call({ tool: 'Read', file_path: 'a.ts' } as never)
  expect(tool).toEqual({ result: 'ok' })

  const first = await $.tool.call(call(PROGRESS))
  expect(first).toMatchObject({ result: { stop: false, mainChat: ['Main chat started Read a.ts'] } })

  // A subagent's turn ending does not stop the watcher.
  await $.turn.complete(turnComplete({ agentId: 'h9' }))
  const pending = $.tool.call(call(PROGRESS))
  await w.clock.advance(7000)
  expect(await pending).toMatchObject({ result: { stop: false, mainChat: ['(no new activity)'] } })

  await $.turn.complete(turnComplete())
  const last = await $.tool.call(call(PROGRESS))
  expect(last).toMatchObject({ result: { stop: true, reason: 'The main turn ended.', mainChat: ['Main turn ended'] } })
})

test('a waiting progress call wakes on new main-chat activity', async ($, on) => {
  const w = await boosted($, on)
  let isSettled = false
  const pending = $.tool.call(call(PROGRESS)).then(r => {
    isSettled = true
    return r
  })
  await w.clock.advance(1000)
  expect(isSettled).toBe(false)
  await $.tool.call({ tool: 'Grep', pattern: 'foo' } as never)
  await w.clock.settle()
  expect(await pending).toMatchObject({ result: { stop: false, mainChat: ['Main chat started Grep foo'] } })
})

test('/boost stop tells the watcher to stop and refuses new helpers', async ($, on) => {
  const w = await boosted($, on)
  expect(await $.command.run(boostCmd('stop'))).toMatchObject({ text: expect.stringContaining('Boost stopping') })
  expect(await $.tool.call(call(PROGRESS))).toMatchObject({ result: { stop: true, reason: 'The person stopped the boost.' } })
  expect(await $.tool.call(call(SPAWN, { description: 'x', prompt: 'y' }))).toMatchObject({ deny: expect.stringContaining('stopping') })

  // The watcher ends: the next poll turns the boost off, and /boost can start a new one.
  w.agents = [{ id: 'w1', description: 'Boost watcher', type: 'session-boost:watcher', status: 'completed' }]
  await w.clock.advance(2000)
  expect(await $.command.run(boostCmd())).toMatchObject({ text: expect.stringContaining('Boost started') })
  expect(w.spawns.filter(s => s.subagentType === 'session-boost:watcher')).toHaveLength(2)
})

test('a watcher that ends on its own winds the boost down once its helpers finish', async ($, on) => {
  const w = await boosted($, on)
  await $.tool.call(call(SPAWN, { description: 'task 1', prompt: 'p1' }))
  await w.clock.advance(2000)
  w.agents = [
    { id: 'w1', description: 'Boost watcher', type: 'session-boost:watcher', status: 'completed' },
    { id: 'h1', description: 'task 1', type: 'session-boost:helper', status: 'running' },
  ]
  await w.clock.advance(2000)
  // Still stopping while h1 runs.
  expect(await $.command.run(boostCmd())).toMatchObject({ text: expect.stringContaining('already running') })

  await $.turn.complete(turnComplete({ agentId: 'h1', answer: 'ok' }))
  w.agents = w.agents.map(a => ({ ...a, status: 'completed' as const }))
  await w.clock.advance(2000)
  expect(await $.command.run(boostCmd())).toMatchObject({ text: expect.stringContaining('Boost started') })
})

test('the mod\'s agent types are never offered to the model', async ($, on) => {
  world(on)
  for (const agent of ['session-boost:watcher', 'session-boost:helper']) {
    const offer = await $.agent.offer({
      agent,
      description: 'x',
      source: 'plugin',
      provider: { plugin: 'session-boost', tier: 'user' },
    } as never)
    expect(offer).toEqual({ isOffered: false })
  }
})

test('a helper killed without a turn.complete is settled by the poll, once', async ($, on) => {
  const w = await boosted($, on)
  await $.tool.call(call(SPAWN, { description: 'run tests', prompt: 'Run the tests.' }))
  await w.clock.advance(2000)
  expect(helperSpawns(w)).toHaveLength(1)
  w.agents = [...w.agents, { id: 'h1', description: 'run tests', type: 'session-boost:helper', status: 'killed' }]
  w.transcripts.set('h1', [{ role: 'assistant', text: 'Two tests failed before it was killed', toolUses: [] }])

  // One look is not enough: turn.complete may still be on its way.
  await w.clock.advance(2000)
  expect(w.session.appended()).toHaveLength(0)
  await w.clock.advance(2000)
  const delivered = w.session.appended().map(row => JSON.stringify(row))
  expect(delivered).toHaveLength(1)
  expect(delivered[0]).toContain('helper failed: run tests')
  expect(delivered[0]).toContain('Two tests failed before it was killed')

  // A late turn.complete delivers nothing twice.
  await $.turn.complete(turnComplete({ agentId: 'h1', answer: 'late' }))
  await w.clock.advance(2000)
  expect(w.session.appended()).toHaveLength(1)
})

test('a watcher missing from one agent.list is not taken for gone', async ($, on) => {
  const w = await boosted($, on)
  w.agents = []
  await w.clock.advance(2000)
  expect(await $.command.run(boostCmd())).toMatchObject({ text: expect.stringContaining('already running') })
  w.agents = [{ id: 'w1', description: 'Boost watcher', type: 'session-boost:watcher', status: 'running' }]
  await w.clock.advance(2000)
  w.agents = []
  await w.clock.advance(2000)
  expect(await $.command.run(boostCmd())).toMatchObject({ text: expect.stringContaining('already running') })
})

/** A spawn as the Agent tool raises it: no model named unless the caller gave one. */
const agentToolSpawn = (extra: Record<string, unknown>) =>
  ({
    tool_use_id: 'tu1',
    prompt: 'Check the plugin docs',
    description: 'Verify plugin marketplace docs',
    subagentType: 'claude-code-guide',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: MODEL,
    background: true,
    fork: false,
    ...extra,
  }) as never

test('a subagent whose definition pins a model runs on the chat model instead', async ($, on) => {
  const w = world(on)
  await start($)
  w.nextIds = ['g1']
  await $.agent.spawn(agentToolSpawn({}))
  expect(w.spawns.at(-1)?.model).toBe(MODEL)

  // A model the caller named is kept.
  w.nextIds = ['g2']
  await $.agent.spawn(agentToolSpawn({ model: 'claude-haiku-5-5' }))
  expect(w.spawns.at(-1)?.model).toBe('claude-haiku-5-5')
})

test('the panel shows each subagent\'s model and one cheaper model that suits its job', async ($, on) => {
  const w = world(on)
  await start($)
  w.nextIds = ['g1']
  await $.agent.spawn(agentToolSpawn({}))
  w.agents = [
    { id: 'g1', description: 'Verify plugin marketplace docs', type: 'claude-code-guide', status: 'running' },
    { id: 'r1', description: 'Review session-boost logic', type: 'general-purpose', status: 'running' },
  ]
  w.transcripts.set('g1', [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u1', tool: 'WebFetch', input: { url: 'https://code.claude.com/docs' } }] }])
  await w.clock.advance(2000)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /claude-code-guide · claude-opus-5-5/ })).toBeDefined()
  // One suggestion only: the cheapest that suits the job, with its price against what the subagent runs on.
  expect(
    await ui.find({ type: 'Text', text: /lookup job · Haiku 5\.5 costs \$0\.10\/\$0\.50, 98% less · click ▲ to start future claude-code-guide lookup jobs on it/ }),
  ).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Sonnet 5\.5/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /reasoning job · already on the cheapest model that suits it/ })).toBeDefined()
})

/** The panel's overspend cues: the yellow `▲ use …` texts, by the model they name. */
async function cues(ui: Awaited<ReturnType<typeof mountPane>>) {
  const texts = await ui.findAll({ type: 'Text', text: /▲ use / })
  return texts.filter(t => t.props.color === 'yellow')
}

test('the overspend cue shows only where a cheaper capable model exists, naming it', async ($, on) => {
  const w = world(on)
  await start($)
  // Three spawns, each recorded with the model it ran on: two on the chat's (Opus 5.5), one asked for Haiku.
  w.nextIds = ['look', 'code', 'think', 'cheap']
  await $.agent.spawn(agentToolSpawn({ description: 'Find call sites', subagentType: 'Explore' }))
  await $.agent.spawn(agentToolSpawn({ description: 'Add the button story', subagentType: 'general-purpose' }))
  await $.agent.spawn(agentToolSpawn({ description: 'Review the auth design', subagentType: 'general-purpose' }))
  await $.agent.spawn(agentToolSpawn({ description: 'Find the docs page', subagentType: 'Explore', model: 'claude-haiku-5-5' }))
  w.agents = [
    { id: 'look', description: 'Find call sites', type: 'Explore', status: 'running' },
    { id: 'code', description: 'Add the button story', type: 'general-purpose', status: 'running' },
    { id: 'think', description: 'Review the auth design', type: 'general-purpose', status: 'running' },
    { id: 'cheap', description: 'Find the docs page', type: 'Explore', status: 'running' },
  ]
  w.transcripts.set('code', [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u', tool: 'Write', input: { file_path: 'b.stories.tsx' } }] }])
  await w.clock.advance(2000)

  const ui = await mountPane($)
  const shown = (await cues(ui)).map(t => t.text.trim())
  // Lookup on Opus → Haiku; coding on Opus → Sonnet; review on Opus and lookup already on Haiku → nothing.
  expect(shown.sort()).toEqual(['▲ use Haiku 5.5', '▲ use Sonnet 5.5'])
  const rows = await ui.findAll({ type: 'Text', text: /Review the auth design|Find the docs page/ })
  for (const row of rows) expect(row.text).not.toContain('▲')
})

test('the overspend cue blinks while its subagent runs, and stays steady once it ends', async ($, on) => {
  const w = world(on)
  await start($)
  w.nextIds = ['look']
  await $.agent.spawn(agentToolSpawn({ description: 'Find call sites', subagentType: 'Explore' }))
  w.agents = [{ id: 'look', description: 'Find call sites', type: 'Explore', status: 'running' }]
  await w.clock.advance(2000)

  const ui = await mountPane($)
  const phases: boolean[] = []
  for (let i = 0; i < 4; i++) {
    await w.clock.advance(500)
    await ui.drawn()
    phases.push((await cues(ui))[0]?.props.inverse === true)
  }
  // It alternates: highlighted, plain, highlighted, plain (in some order).
  expect(phases.filter(Boolean)).toHaveLength(2)
  expect(phases[0]).not.toBe(phases[1])

  w.agents = [{ id: 'look', description: 'Find call sites', type: 'Explore', status: 'completed' }]
  await w.clock.advance(2000)
  const steady: boolean[] = []
  for (let i = 0; i < 3; i++) {
    await w.clock.advance(500)
    await ui.drawn()
    const cue = (await cues(ui))[0]
    expect(cue?.text.trim()).toBe('▲ use Haiku 5.5')
    steady.push(cue?.props.inverse === true)
  }
  expect(steady).toEqual([false, false, false])
})

test('no row blinks when every subagent already runs on its cheapest capable model', async ($, on) => {
  const w = world(on)
  await start($)
  w.nextIds = ['think']
  await $.agent.spawn(agentToolSpawn({ description: 'Review the auth design', subagentType: 'general-purpose' }))
  w.agents = [{ id: 'think', description: 'Review the auth design', type: 'general-purpose', status: 'running' }]
  await w.clock.advance(2000)
  const ui = await mountPane($)
  await w.clock.advance(1500)
  expect(await cues(ui)).toEqual([])
})

/** A lookup subagent ('look', an Explore on the chat's Opus 5.5) listed and drawn, its button ready. */
async function lookupRow($: Engine, on: On) {
  const w = world(on)
  await start($)
  w.nextIds = ['look', 'next', 'other', 'more']
  await $.agent.spawn(agentToolSpawn({ description: 'Find call sites', subagentType: 'Explore' }))
  w.agents = [{ id: 'look', description: 'Find call sites', type: 'Explore', status: 'running' }]
  await w.clock.advance(2000)
  const ui = await mountPane($)
  return { w, ui }
}

test('clicking the suggestion starts future subagents of that kind on it', async ($, on) => {
  const { w, ui } = await lookupRow($, on)
  await ui.press({ key: 'use-look' })
  expect(w.toasts).toContain('Future Explore lookup jobs will start on Haiku 5.5')
  expect(w.stored.prefs).toEqual({ 'Explore:lookup': 'claude-haiku-5-5' })

  // The next Explore lookup starts on Haiku; a different kind still follows the chat.
  await $.agent.spawn(agentToolSpawn({ description: 'Find the config loader', subagentType: 'Explore' }))
  expect(w.spawns.at(-1)?.model).toBe('claude-haiku-5-5')
  await $.agent.spawn(agentToolSpawn({ description: 'Add the button story', subagentType: 'general-purpose' }))
  expect(w.spawns.at(-1)?.model).toBe(MODEL)
  // A caller that names a model still gets it.
  await $.agent.spawn(agentToolSpawn({ description: 'Find more', subagentType: 'Explore', model: 'claude-sonnet-5-5' }))
  expect(w.spawns.at(-1)?.model).toBe('claude-sonnet-5-5')
})

test('a picked suggestion shows ✓, stops blinking, and a second click undoes it', async ($, on) => {
  const { w, ui } = await lookupRow($, on)
  await ui.press({ key: 'use-look' })
  await ui.drawn()
  const picked = (await cues(ui)).length === 0 ? await ui.find({ type: 'Text', text: /✓ Haiku 5\.5/ }) : undefined
  expect(picked).toBeDefined()
  for (let i = 0; i < 3; i++) {
    await w.clock.advance(500)
    await ui.drawn()
    expect((await ui.find({ type: 'Text', text: /✓ Haiku 5\.5/ }))?.props.inverse).not.toBe(true)
  }
  expect(await ui.find({ type: 'Text', text: /future Explore lookup jobs start on Haiku 5\.5 · click ✓ to undo/ })).toBeDefined()

  await ui.press({ key: 'use-look' })
  expect(w.toasts).toContain("Future Explore lookup jobs follow the chat's model again")
  expect(w.stored.prefs).toEqual({})
  await $.agent.spawn(agentToolSpawn({ description: 'Find the config loader', subagentType: 'Explore' }))
  expect(w.spawns.at(-1)?.model).toBe(MODEL)
})

test('a pick is kept across sessions and never runs pricier than the chat', async ($, on) => {
  const w = world(on, { prefs: { 'Explore:lookup': 'claude-sonnet-5-5' } })
  await start($)
  await $.agent.spawn(agentToolSpawn({ description: 'Find call sites', subagentType: 'Explore' }))
  expect(w.spawns.at(-1)?.model).toBe('claude-sonnet-5-5')
  // The chat on Haiku: the Sonnet pick would cost more, so the spawn follows the chat.
  await $.agent.spawn(agentToolSpawn({ description: 'Find call sites', subagentType: 'Explore', parentModel: 'claude-haiku-5-5' }))
  expect(w.spawns.at(-1)?.model).toBe('claude-haiku-5-5')
})
