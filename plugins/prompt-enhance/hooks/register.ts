import type { Register } from 'claude-code'

import { buildPrompt, clean, EFFORT, fillMode, MAX_TOKENS, parseTrigger, recentContext, SYSTEM, TIMEOUT_MS } from './enhance'

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer') return next(e)
    const text = parseTrigger(e.text)
    if (text === null) return next(e)
    if (text === '') return { drop: 'Nothing to enhance: type a prompt before ++' }

    // The prompt is dropped at once; the enhancement lands in the box when ready.
    // Work that outlives this dispatch runs from a clock timer, as the docs ask,
    // so it is not tied to (or aborted with) the prompt.submit dispatch.
    $.clock.after(0, () => void enhance(text))

    return { drop: 'Enhancing prompt…' }

    async function enhance(text: string) {
      $.ui.status('Enhancing prompt…')
      try {
        // The model the chat is running now, as /model shows it.
        const [model, cwd, rows] = await Promise.all([$.session.model(), $.session.cwd(), $.session.messages()])
        const reply = await $.model.complete({
          model,
          system: SYSTEM,
          prompt: buildPrompt(text, cwd, recentContext(rows)),
          effort: EFFORT,
          maxTokens: MAX_TOKENS,
          timeoutMs: TIMEOUT_MS,
        })
        const box = await $.prompt.read()
        const mode = fillMode(box.text, text, e.text)
        if (!reply.isAnswered) {
          await $.prompt.fill({ text: e.text, mode })
          $.ui.toast(`Could not enhance the prompt (${reply.reason}); your original is back`)
          return
        }
        await $.prompt.fill({ text: clean(reply.text), mode })
        $.ui.toast('Enhanced prompt is in the prompt bar: review, then Enter')
      } catch (error) {
        $.ui.toast(`Could not enhance the prompt: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        $.ui.status(undefined)
      }
    }
  }).catch(($, e, next) => next(e)) // a failing hook lets the prompt through
}
