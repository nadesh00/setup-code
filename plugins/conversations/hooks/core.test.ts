import { expect, test } from 'claude-code/testing'

import { cleanTitle, projectSlug, promptText, relativeTime, scanTranscript } from './core'

const line = (row: Record<string, unknown>) => JSON.stringify(row)

test('projectSlug dashes every non-alphanumeric character', () => {
  expect(projectSlug('/Users/me/Desktop/my app.v2')).toBe('-Users-me-Desktop-my-app-v2')
})

test('scanTranscript keeps titles and the typed prompts only', () => {
  const text = [
    line({ type: 'user', message: { role: 'user', content: '<local-command-caveat>Caveat</local-command-caveat>' } }),
    line({ type: 'user', message: { role: 'user', content: 'fix the login bug' } }),
    line({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta row' } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'and add a test' }] } }),
    line({ type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent prompt' } }),
    line({ type: 'ai-title', aiTitle: 'Login bug fix' }),
    'not json',
  ].join('\n')
  const scanned = scanTranscript(text)
  expect(scanned.prompts).toEqual(['fix the login bug', 'and add a test'])
  expect(scanned.promptCount).toBe(2)
  expect(scanned.aiTitle).toBe('Login bug fix')
})

test('a custom title is read beside the AI one', () => {
  const scanned = scanTranscript([line({ type: 'ai-title', aiTitle: 'A' }), line({ type: 'custom-title', customTitle: 'Mine' })].join('\n'))
  expect(scanned.customTitle).toBe('Mine')
})

test('promptText drops commands and interrupts', () => {
  expect(promptText({ content: '<command-name>/model</command-name>' })).toBeNull()
  expect(promptText({ content: '[Request interrupted by user]' })).toBeNull()
  expect(promptText({ content: '  hi  ' })).toBe('hi')
})

test('cleanTitle strips labels, quotes and extra lines', () => {
  expect(cleanTitle('Title: "Fix login bug."\nmore')).toBe('Fix login bug')
})

test('relativeTime reads as a person would say it', () => {
  const now = 1_000_000_000_000
  expect(relativeTime(now - 30_000, now)).toBe('just now')
  expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago')
  expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago')
  expect(relativeTime(now - 26 * 3_600_000, now)).toBe('yesterday')
  expect(relativeTime(now - 9 * 86_400_000, now)).toBe('9 days ago')
})
