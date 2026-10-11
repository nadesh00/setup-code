import type { On } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'

const DIR = '/home/me/.claude/projects/-repo'
const line = (row: Record<string, unknown>) => JSON.stringify(row)
const prompt = (text: string) => line({ type: 'user', message: { role: 'user', content: text } })

/** The disk beneath the plugin: the project's transcripts, by file name. */
function world(on: On) {
  const w = {
    files: new Map<string, { text: string; mtimeMs: number }>(),
    models: [] as string[],
    resumed: [] as string[],
    clock: mock.clock(on),
    store: mock.store(on),
  }
  mock.env(on, { HOME: '/home/me' })
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('ui.toast', async () => ({ value: undefined }))
  on('session.root', async () => ({ value: '/repo' }))
  on('session.id', async () => ({ value: 'current' }))
  on('fs.exists', async (_$, e) => ({ value: (e as unknown as { path: string }).path === DIR }))
  on('fs.list', async () => ({
    value: [...w.files].map(([name, f]) => ({ name, kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })),
  }))
  on('fs.read', async (_$, e) => {
    const path = (e as unknown as { path: string }).path
    return { value: w.files.get(path.slice(DIR.length + 1))?.text ?? '' }
  })
  on('model.complete', async (_$, e) => {
    w.models.push(e.prompt)
    return { value: { isAnswered: true, text: 'Title: "Set up Storybook."', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('command.run', async (_$, e) => {
    w.resumed.push(`${e.command} ${e.args}`)
    return { text: 'resumed' }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))

  return w
}

async function open($: Engine, w: ReturnType<typeof world>) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const result = await $.command.run({ command: 'conversations', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never)
  await w.clock.settle()
  const ui = await $.ui.mount({
    plugin: 'conversations',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'conversations',
    viewport: { columns: 160, rows: 40, isFullscreen: true },
    props: { title: 'Past conversations', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  } as never)
  return { ui, result }
}

test('lists past conversations by meaningful title, newest first, without the current one', async ($, on) => {
  const w = world(on)
  const now = Date.now()
  w.files.set('aaa.jsonl', { text: [prompt('crash logs?'), line({ type: 'ai-title', aiTitle: 'Brave browser crash logs' })].join('\n'), mtimeMs: now - 2 * 86_400_000 })
  w.files.set('bbb.jsonl', { text: [prompt('install storybook in this repo'), prompt('and add a button story')].join('\n'), mtimeMs: now - 3_600_000 })
  w.files.set('ccc.jsonl', { text: line({ type: 'user', message: { content: '<command-name>/model</command-name>' } }), mtimeMs: now })
  w.files.set('ddd.jsonl', { text: [prompt('x'), line({ type: 'custom-title', customTitle: 'My renamed chat' })].join('\n'), mtimeMs: now - 60_000 })
  w.files.set('current.jsonl', { text: prompt('this very session'), mtimeMs: now })

  const { ui, result } = await open($, w)
  expect(result).toMatchObject({ text: expect.stringContaining('Past conversations') })

  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.map(b => b.props.label)).toEqual(['My renamed chat', 'Set up Storybook', 'Brave browser crash logs'])
  expect(await ui.find({ type: 'Text', text: /1 h ago · 2 prompts/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 days ago · 1 prompt\b/ })).toBeDefined()
  // Only the untitled one costs a model call, and it is given the person's prompts.
  expect(w.models).toHaveLength(1)
  expect(w.models[0]).toContain('install storybook in this repo')
})

test('clicking a conversation resumes it', async ($, on) => {
  const w = world(on)
  w.files.set('aaa.jsonl', { text: [prompt('crash logs?'), line({ type: 'ai-title', aiTitle: 'Brave browser crash logs' })].join('\n'), mtimeMs: Date.now() })
  const { ui } = await open($, w)
  await ui.press({ key: 'open-aaa' })
  expect(w.resumed).toEqual(['resume aaa'])
})

test('a generated title is kept in the store and not asked for again', async ($, on) => {
  const w = world(on)
  w.files.set('bbb.jsonl', { text: prompt('install storybook'), mtimeMs: 5 })
  await open($, w)
  await $.command.run({ command: 'conversations', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never)
  await w.clock.settle()
  expect(w.models).toHaveLength(1)
})
