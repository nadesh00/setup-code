export const PANE = 'conversations'
export const TITLE_MODEL = 'haiku'
/** Conversations listed, newest first. */
export const MAX_LISTED = 60
/** Prompts read from a transcript to title it. */
export const PROMPTS_FOR_TITLE = 6

/** The folder Claude Code keeps a project's transcripts in: the path with every other character a dash. */
export function projectSlug(root: string): string {
  return root.replace(/[^a-zA-Z0-9]/g, '-')
}

export type Scanned = {
  customTitle?: string
  aiTitle?: string
  /** The person's typed prompts, in order (commands, caveats and tool results left out). */
  prompts: string[]
  promptCount: number
}

/** What a transcript's JSONL lines say about it: its titles and the person's own prompts. */
export function scanTranscript(text: string): Scanned {
  const scanned: Scanned = { prompts: [], promptCount: 0 }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (row.type === 'custom-title' && typeof row.customTitle === 'string') scanned.customTitle = row.customTitle
    else if (row.type === 'ai-title' && typeof row.aiTitle === 'string') scanned.aiTitle = row.aiTitle
    else if (row.type === 'summary' && typeof row.summary === 'string' && !scanned.aiTitle) scanned.aiTitle = row.summary
    else if (row.type === 'user' && row.isMeta !== true && row.isSidechain !== true) {
      const prompt = promptText(row.message)
      if (prompt === null) continue
      scanned.promptCount += 1
      if (scanned.prompts.length < PROMPTS_FOR_TITLE) scanned.prompts.push(prompt)
    }
  }

  return scanned
}

/** A user row's typed text, or null for a command, a caveat, an interrupt or a tool result. */
export function promptText(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null
  const content = (message as { content?: unknown }).content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    if (content.some(block => (block as { type?: string })?.type === 'tool_result')) return null
    text = content
      .filter(block => (block as { type?: string })?.type === 'text')
      .map(block => String((block as { text?: unknown }).text ?? ''))
      .join('\n')
  }
  text = text.trim()
  if (text === '' || text.startsWith('<') || text.startsWith('[Request interrupted')) return null

  return text
}

export function titlePrompt(prompts: readonly string[]): string {
  return [
    'Here are the first prompts a person typed in a Claude Code session. Write a title for the conversation:',
    '3 to 7 words, sentence case, naming what it was about (the task or topic), no quotes, no trailing period.',
    'Reply with the title only.',
    '',
    ...prompts.map((prompt, i) => `<prompt ${i + 1}>\n${prompt.slice(0, 1500)}\n</prompt ${i + 1}>`),
  ].join('\n')
}

/** A model's title, tidied: one line, no quotes or label, capped. */
export function cleanTitle(text: string): string {
  const line = (text.trim().split('\n')[0] ?? '')
    .replace(/^title:\s*/i, '')
    .replace(/^["'“]+|["'”]+$/g, '')
    .replace(/[.。]+$/, '')
    .replace(/["'”]+$/, '')
    .trim()

  return oneLine(line, 80)
}

/** A title from the first prompt itself, when no model answers. */
export function promptTitle(prompt: string): string {
  return oneLine(prompt.charAt(0).toUpperCase() + prompt.slice(1), 60)
}

export function relativeTime(then: number, now: number): string {
  const minutes = Math.floor((now - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.round(days / 30)

  return months < 12 ? `${months} mo ago` : `${Math.round(months / 12)} y ago`
}

export function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
