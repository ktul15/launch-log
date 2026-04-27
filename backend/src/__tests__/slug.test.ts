import { toSlug } from '../utils/slug'

describe('toSlug', () => {
  // ─── ASCII happy paths ────────────────────────────────────────────────────

  it('converts ASCII name to kebab-case slug', () => {
    expect(toSlug('My Cool Org')).toBe('my-cool-org')
  })

  it('strips special characters', () => {
    expect(toSlug('Hello & World!')).toBe('hello-world')
  })

  it('removes leading and trailing hyphens', () => {
    expect(toSlug('--Acme--')).toBe('acme')
  })

  it('preserves numbers', () => {
    expect(toSlug('Org 42')).toBe('org-42')
  })

  it('collapses consecutive whitespace and separators into one hyphen', () => {
    expect(toSlug('a   b')).toBe('a-b')
  })

  it('converts to lowercase', () => {
    expect(toSlug('UPPER CASE')).toBe('upper-case')
  })

  it('handles digit-only names without fallback', () => {
    expect(toSlug('123')).toBe('123')
  })

  // ─── Hex fallback ─────────────────────────────────────────────────────────

  it('returns 8-char hex for non-ASCII Cyrillic input', () => {
    const warn = jest.fn()
    const result = toSlug('Привет', { warn })
    expect(result).toMatch(/^[0-9a-f]{8}$/)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('[toSlug]')
    expect(warn.mock.calls[0][0]).toContain('Привет')
  })

  it('returns 8-char hex for non-ASCII CJK input', () => {
    const warn = jest.fn()
    const result = toSlug('你好', { warn })
    expect(result).toMatch(/^[0-9a-f]{8}$/)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('[toSlug]')
    expect(warn.mock.calls[0][0]).toContain('你好')
  })

  it('returns 8-char hex for empty string input', () => {
    const warn = jest.fn()
    const result = toSlug('', { warn })
    expect(result).toMatch(/^[0-9a-f]{8}$/)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('returns 8-char hex when ASCII portion strips to a single character', () => {
    // Pure-ASCII input that normalises to length 1 — e.g. "A!" → "a" (length 1 < 2)
    const warn = jest.fn()
    const result = toSlug('A!', { warn })
    expect(result).toMatch(/^[0-9a-f]{8}$/)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  // ─── Boundary: ASCII portion length around threshold ─────────────────────

  it('falls back to hex when ASCII portion is shorter than 2 chars', () => {
    // "a привет" → normalises to "a" (length 1) → hex fallback
    const warn = jest.fn()
    const result = toSlug('a привет', { warn })
    expect(result).toMatch(/^[0-9a-f]{8}$/)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('does not fall back when ASCII portion is at least 2 chars', () => {
    // "ab привет" → normalises to "ab" (length 2) → no fallback
    const warn = jest.fn()
    const result = toSlug('ab привет', { warn })
    expect(result).toBe('ab')
    expect(warn).not.toHaveBeenCalled()
  })

  // ─── Logger paths ─────────────────────────────────────────────────────────

  it('calls console.warn when no logger is provided and fallback occurs', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      toSlug('Привет')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0]).toContain('[toSlug]')
    } finally {
      spy.mockRestore()
    }
  })

  it('does not call log.warn for normal ASCII input', () => {
    const warn = jest.fn()
    toSlug('Normal Org', { warn })
    expect(warn).not.toHaveBeenCalled()
  })
})
