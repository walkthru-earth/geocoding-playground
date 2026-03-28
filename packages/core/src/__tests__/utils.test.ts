import { describe, expect, it } from 'vitest'
import { addStep, esc, fmt, fmtFull, formatSize, toArr, updateLastStep } from '../utils'

describe('fmt', () => {
  it.each([
    [1_500_000_000, '1.5B'],
    [1_000_000_000, '1.0B'],
    [3_500_000, '3.5M'],
    [1_000_000, '1.0M'],
    [10_200, '10.2K'],
    [1_000, '1.0K'],
    [999, '999'],
    [0, '0'],
  ])('formats %d as %s', (input, expected) => {
    expect(fmt(input)).toBe(expected)
  })
})

describe('fmtFull', () => {
  it('formats with locale separators', () => {
    const result = fmtFull(1234567)
    expect(result).toMatch(/1.*234.*567/)
  })
})

describe('formatSize', () => {
  it.each([
    [-1, 'N/A'],
    [0, '0B'],
    [512, '512B'],
    [1023, '1023B'],
    [1024, '1KB'],
    [51200, '50KB'],
    [1048576, '1.0MB'],
    [5242880, '5.0MB'],
  ])('formats %d bytes as %s', (input, expected) => {
    expect(formatSize(input)).toBe(expected)
  })
})

describe('esc', () => {
  it('escapes single quotes', () => {
    expect(esc("O'Brien")).toBe("O''Brien")
  })

  it('escapes multiple single quotes', () => {
    expect(esc("it's a test's")).toBe("it''s a test''s")
  })

  it('returns clean strings unchanged', () => {
    expect(esc('hello')).toBe('hello')
  })
})

describe('toArr', () => {
  it('passes arrays through', () => {
    expect(toArr(['a', 'b'])).toEqual(['a', 'b'])
  })

  it('converts iterables to arrays', () => {
    const iterable = {
      *[Symbol.iterator]() {
        yield 'x'
        yield 'y'
      },
    }
    expect(toArr(iterable)).toEqual(['x', 'y'])
  })
})

describe('addStep', () => {
  it('appends a step entry', () => {
    const steps = addStep([], 'Loading')
    expect(steps).toEqual([{ text: 'Loading', status: undefined }])
  })

  it('preserves existing steps', () => {
    const steps = addStep([{ text: 'A' }], 'B', 'done')
    expect(steps).toHaveLength(2)
    expect(steps[1]).toEqual({ text: 'B', status: 'done' })
  })

  it('returns a new array (immutable)', () => {
    const original = [{ text: 'A' }]
    const result = addStep(original, 'B')
    expect(result).not.toBe(original)
  })
})

describe('updateLastStep', () => {
  it('replaces the last step', () => {
    const steps = updateLastStep([{ text: 'Loading' }, { text: 'Done' }], 'Updated', 'error')
    expect(steps).toHaveLength(2)
    expect(steps[1]).toEqual({ text: 'Updated', status: 'error' })
  })

  it('returns a new array (immutable)', () => {
    const original = [{ text: 'A' }]
    const result = updateLastStep(original, 'B')
    expect(result).not.toBe(original)
  })
})
