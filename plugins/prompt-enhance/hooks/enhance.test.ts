import { describe, expect, test } from 'claude-code/testing'

import { buildPrompt, clean, fillMode, parseTrigger, recentContext } from './enhance'

describe('parseTrigger', () => {
  test('strips a trailing " ++"', () => {
    expect(parseTrigger('fix it ++')).toBe('fix it')
  })
  test('allows trailing whitespace after the marker and trims the text', () => {
    expect(parseTrigger('  fix it ++  \n')).toBe('fix it')
    expect(parseTrigger('fix it\n++')).toBe('fix it')
    expect(parseTrigger('fix it\t++')).toBe('fix it')
  })
  test('a bare "++" is an empty enhancement', () => {
    expect(parseTrigger('++')).toBe('')
    expect(parseTrigger('  ++ ')).toBe('')
  })
  test('ignores ++ without whitespace before it', () => {
    expect(parseTrigger('c++')).toBeNull()
    expect(parseTrigger('i++')).toBeNull()
  })
  test('ignores ++ that is not at the end', () => {
    expect(parseTrigger('a++b')).toBeNull()
    expect(parseTrigger('use ++ here')).toBeNull()
  })
  test('ignores prompts without a marker', () => {
    expect(parseTrigger('fix it')).toBeNull()
    expect(parseTrigger('fix it +')).toBeNull()
    expect(parseTrigger('')).toBeNull()
  })
  test('only the final marker is removed', () => {
    expect(parseTrigger('learn c++ ++')).toBe('learn c++')
  })
})

describe('clean', () => {
  test('leaves plain text alone (trimmed)', () => {
    expect(clean('  do the thing  ')).toBe('do the thing')
  })
  test('strips code fences, with or without a language', () => {
    expect(clean('```\ndo the thing\n```')).toBe('do the thing')
    expect(clean('```text\ndo the thing\n```')).toBe('do the thing')
  })
  test('keeps fences inside the text', () => {
    const inner = 'Run:\n```sh\nnpm test\n```\nthen fix'
    expect(clean(inner)).toBe(inner)
  })
  test('strips surrounding straight quotes', () => {
    expect(clean('"do the thing"')).toBe('do the thing')
    expect(clean("'do the thing'")).toBe('do the thing')
  })
  test('strips surrounding curly quotes', () => {
    expect(clean('“do the thing”')).toBe('do the thing')
  })
  test('keeps unbalanced or mismatched quotes', () => {
    expect(clean('"do the thing')).toBe('"do the thing')
    expect(clean('"do the thing\'')).toBe('"do the thing\'')
  })
  test('keeps inner quotes', () => {
    expect(clean('rename "a" to "b"')).toBe('rename "a" to "b"')
  })
  test('strips quotes inside a fence', () => {
    expect(clean('```\n"do the thing"\n```')).toBe('do the thing')
  })
})

describe('fillMode', () => {
  test('replaces an empty or blank box', () => {
    expect(fillMode('')).toBe('replace')
    expect(fillMode('   \n')).toBe('replace')
  })
  test('replaces when the box still holds our prompt', () => {
    expect(fillMode('fix it', 'fix it', 'fix it ++')).toBe('replace')
    expect(fillMode(' fix it ++ ', 'fix it', 'fix it ++')).toBe('replace')
  })
  test('appends after a new draft', () => {
    expect(fillMode('something else', 'fix it', 'fix it ++')).toBe('append')
    expect(fillMode('something else')).toBe('append')
  })
})

describe('recentContext', () => {
  const row = (role: 'user' | 'assistant', text: string) => ({ role, text })

  test('empty for no rows', () => {
    expect(recentContext([])).toBe('')
  })
  test('labels roles, oldest first, skips blank rows', () => {
    expect(recentContext([row('user', 'hi'), row('assistant', '  '), row('assistant', 'hello')])).toBe(
      'User: hi\n\nAssistant: hello',
    )
  })
  test('keeps at most the 6 newest rows', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row('user', `m${i}`))
    const out = recentContext(rows)
    expect(out.split('\n\n')).toEqual(['m4', 'm5', 'm6', 'm7', 'm8', 'm9'].map(t => `User: ${t}`))
  })
  test('clips each row to 1200 chars with an ellipsis', () => {
    const out = recentContext([row('assistant', 'x'.repeat(2000))])
    expect(out).toBe(`Assistant: ${'x'.repeat(1200)}…`)
  })
  test('caps the total at 6000 chars, keeping the newest', () => {
    const rows = Array.from({ length: 6 }, (_, i) => row('user', String(i).repeat(1500)))
    const out = recentContext(rows)
    expect(out.length).toBeLessThanOrEqual(6000 + 2 * 5)
    const lines = out.split('\n\n')
    // each line is "User: " + 1200 + "…" = 1207 chars; 4 fit in 6000, 5 do not
    expect(lines).toHaveLength(4)
    expect(lines[3]).toStartWith('User: 5')
    expect(lines[0]).toStartWith('User: 2')
  })
})

describe('buildPrompt', () => {
  test('wraps the prompt and includes cwd and context', () => {
    const out = buildPrompt('fix it', '/repo', 'User: hi')
    expect(out).toContain('<working_directory>/repo</working_directory>')
    expect(out).toContain('<recent_conversation>\nUser: hi\n</recent_conversation>')
    expect(out).toEndWith('<prompt_to_enhance>\nfix it\n</prompt_to_enhance>')
    expect(out).toStartWith('Enhance the following prompt. Do NOT answer it')
  })
  test('omits empty cwd and context', () => {
    const out = buildPrompt('fix it', '', '')
    expect(out).not.toContain('<working_directory>')
    expect(out).not.toContain('<recent_conversation>')
    expect(out).toContain('<prompt_to_enhance>\nfix it\n</prompt_to_enhance>')
  })
})
