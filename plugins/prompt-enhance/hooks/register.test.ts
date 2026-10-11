import type { ModelCompleteInput, PromptFillInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

test('a composer prompt ending in " ++" is dropped and its enhancement filled', async ($, on) => {
  const completes: ModelCompleteInput[] = []
  const toasts: string[] = []
  let filled!: (e: PromptFillInput) => void
  const fill = new Promise<PromptFillInput>(resolve => (filled = resolve))

  const clock = mock.clock(on)
  on('session.cwd', async () => ({ value: '/repo' }))
  on('session.messages', async () => ({ value: [] }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('prompt.read', async () => ({ value: { text: '', cursor: 0 } }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('model.complete', async (_$, e) => {
    completes.push(e)
    return { value: { isAnswered: true, text: 'Better prompt', usage } }
  })
  on('prompt.fill', async (_$, e) => {
    filled(e)
    return { isFilled: true }
  })
  on('prompt.submit', async () => {
    throw new Error('the enhanced prompt must not be submitted')
  })

  const result = await $.prompt.submit({ text: 'fix the bug ++', wait: false, origin: { kind: 'composer' } })
  expect(result).toHaveProperty('drop')

  await clock.settle()
  const e = await fill
  expect(e.text).toBe('Better prompt')
  expect(e.mode).toBe('replace')
  expect(completes).toHaveLength(1)
  expect(completes[0]?.prompt).toContain('<prompt_to_enhance>\nfix the bug\n</prompt_to_enhance>')
  expect(completes[0]?.prompt).toContain('<working_directory>/repo</working_directory>')
  expect(completes[0]?.model).toBe('claude-opus-5-5')
  await clock.settle()
  expect(toasts).toEqual(['Enhanced prompt is in the prompt bar: review, then Enter'])
})

test('a bare " ++" is dropped without calling the model', async ($, on) => {
  on('model.complete', async () => {
    throw new Error('model must not be called')
  })
  const result = await $.prompt.submit({ text: '++', wait: false, origin: { kind: 'composer' } })
  expect(result).toEqual({ drop: expect.stringContaining('Nothing to enhance') })
})

test('a plain composer prompt passes through', async ($, on) => {
  const seen: string[] = []
  on('prompt.submit', async (_$, e) => {
    seen.push(e.text)
    return { text: e.text }
  })
  const result = await $.prompt.submit({ text: 'fix the bug', wait: false, origin: { kind: 'composer' } })
  expect(result).not.toHaveProperty('drop')
  expect(result).toMatchObject({ text: 'fix the bug' })
  expect(seen).toEqual(['fix the bug'])
})

test('a " ++" prompt from outside the composer passes through', async ($, on) => {
  const seen: string[] = []
  on('prompt.submit', async (_$, e) => {
    seen.push(e.text)
    return { text: e.text }
  })
  const result = await $.prompt.submit({ text: 'fix the bug ++', wait: false, origin: { kind: 'sdk' } })
  expect(result).not.toHaveProperty('drop')
  expect(seen).toEqual(['fix the bug ++'])
})
