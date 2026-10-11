import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Conversation, Listing } from '../types'
import {
  cleanTitle, MAX_LISTED, oneLine, PANE, projectSlug, promptTitle, relativeTime, scanTranscript, TITLE_MODEL,
  titlePrompt,
} from './core'

const EMPTY: Listing = { status: 'idle', conversations: [] }

const listing = atom({ plugin: 'conversations', key: 'listing' } as const, EMPTY)
const resuming = atom({ plugin: 'conversations', key: 'resuming' } as const, null)

/** What one transcript came to, kept in the store until the file changes. */
type Cached = { size: number; mtimeMs: number; conversation: Conversation | null }

/** `$.fs.read` takes up to 4 MiB; a longer transcript is grepped for what the scan needs. */
const READ_LIMIT = 4 * 1024 * 1024

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'conversations',
      description: 'List this project\'s past conversations by title; pick one to resume it',
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'conversations' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Past conversations', focus: true })
    $.clock.after(0, () => void refresh($))

    return { text: opened.isPlaced ? 'Past conversations: pick one to resume it.' : `Past conversations waits: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: 'conversations' }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [list, pending] = await Promise.all([read($, listing), read($, resuming)])
    const now = Date.now()
    const width = e.props.bodyColumns

    if (list.status === 'error') return <Text color="red">Could not list conversations: {list.error ?? 'unknown error'}</Text>
    if (list.conversations.length === 0) {
      return <Text dimColor>{list.status === 'loading' ? 'Reading past conversations…' : 'No past conversations in this project.'}</Text>
    }

    return (
      <Box flexDirection="column" width={width}>
        {list.status === 'loading' && <Text dimColor>Titling conversations…</Text>}
        {list.conversations.map((conversation, i) => (
          <Box key={conversation.id} flexDirection="column" marginBottom={1}>
            <Button
              key={`open-${conversation.id}`}
              label={oneLine(conversation.title, Math.max(10, width - 4))}
              plain
              {...(i === 0 ? { autoFocus: true as const } : {})}
              onPress={() => resume($, conversation)}
            />
            <Text dimColor wrap="truncate-end">
              {'  '}
              {pending === conversation.id ? 'resuming…' : relativeTime(conversation.updatedAt, now)}
              {` · ${conversation.prompts} prompt${conversation.prompts === 1 ? '' : 's'}`}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}

/** Reopens a conversation: `/resume <id>`, as if the person typed it. */
async function resume($: EngineInterface, conversation: Conversation) {
  await update($, resuming, () => conversation.id)
  try {
    await $.command.run({ command: 'resume', args: conversation.id })
  } catch (error) {
    $.ui.toast(`Could not resume "${conversation.title}": ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await update($, resuming, () => null)
  }
}

/** Lists the project's transcripts, newest first, titling each (from the store where unchanged). */
async function refresh($: EngineInterface) {
  const current = await read($, listing)
  if (current.status === 'loading') return
  await update($, listing, (l): Listing => ({ ...l, status: 'loading' }))
  try {
    const [root, home, configDir, self] = await Promise.all([
      $.session.root(),
      $.env.get('HOME'),
      $.env.get('CLAUDE_CONFIG_DIR'),
      $.session.id(),
    ])
    const dir = `${configDir ?? `${home ?? ''}/.claude`}/projects/${projectSlug(root)}`
    if (!(await $.fs.exists(dir))) {
      await update($, listing, (): Listing => ({ status: 'idle', conversations: [] }))
      return
    }
    const files = (await $.fs.list(dir))
      .filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl') && entry.name !== `${self}.jsonl`)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_LISTED)

    // Cached and quick ones first, so the panel fills at once; titles to generate follow.
    const found: Conversation[] = []
    const untitled: Array<{ path: string; id: string; size: number; mtimeMs: number }> = []
    for (const file of files) {
      const id = file.name.slice(0, -'.jsonl'.length)
      const cached = (await $.store.get(`t:${id}`)) as Cached | undefined
      if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
        if (cached.conversation) found.push(cached.conversation)
        continue
      }
      untitled.push({ path: `${dir}/${file.name}`, id, size: file.size, mtimeMs: file.mtimeMs })
    }
    await show($, found, 'loading')

    for (const file of untitled) {
      const conversation = await describe($, file)
      await $.store.set(`t:${file.id}`, { size: file.size, mtimeMs: file.mtimeMs, conversation } satisfies Cached)
      if (conversation) {
        found.push(conversation)
        await show($, found, 'loading')
      }
    }
    await show($, found, 'idle')
  } catch (error) {
    await update($, listing, (): Listing => ({
      status: 'error',
      conversations: [],
      error: error instanceof Error ? error.message : String(error),
    }))
  }
}

async function show($: EngineInterface, found: readonly Conversation[], status: Listing['status']) {
  const conversations = [...found].sort((a, b) => b.updatedAt - a.updatedAt)
  await update($, listing, (): Listing => ({ status, conversations }))
}

/** One transcript as a listed conversation; null when it holds no prompt (nothing to resume). */
async function describe(
  $: EngineInterface,
  file: { path: string; id: string; size: number; mtimeMs: number },
): Promise<Conversation | null> {
  const text =
    file.size <= READ_LIMIT
      ? await $.fs.read(file.path)
      : (await $.process.run(['grep', '-E', '"type":"(user|ai-title|custom-title|summary)"', file.path])).stdout
  const scanned = scanTranscript(text)
  if (scanned.promptCount === 0) return null
  const base = { id: file.id, updatedAt: file.mtimeMs, prompts: scanned.promptCount }
  if (scanned.customTitle) return { ...base, title: scanned.customTitle, titleSource: 'custom' }
  if (scanned.aiTitle) return { ...base, title: scanned.aiTitle, titleSource: 'ai' }

  const reply = await $.model.complete({
    model: TITLE_MODEL,
    prompt: titlePrompt(scanned.prompts),
    maxTokens: 60,
    effort: 'low',
    timeoutMs: 20_000,
  })
  const title = reply.isAnswered ? cleanTitle(reply.text) : ''
  if (title !== '') return { ...base, title, titleSource: 'generated' }

  return { ...base, title: promptTitle(scanned.prompts[0] ?? ''), titleSource: 'prompt' }
}
