import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchCache } from '../search'

describe('SearchCache', () => {
  let cache: SearchCache<string>

  beforeEach(() => {
    cache = new SearchCache<string>(3, 5000)
  })

  it('stores and retrieves values', () => {
    cache.set('key', 'value')
    expect(cache.get('key')).toBe('value')
  })

  it('returns undefined for missing keys', () => {
    expect(cache.get('missing')).toBeUndefined()
  })

  it('normalizes keys to lowercase trimmed', () => {
    cache.set('  Hello  ', 'world')
    expect(cache.get('hello')).toBe('world')
    expect(cache.get('  HELLO  ')).toBe('world')
  })

  it('clears all entries', () => {
    cache.set('a', '1')
    cache.set('b', '2')
    cache.clear()
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBeUndefined()
  })

  describe('LRU eviction', () => {
    it('evicts oldest entry when full', () => {
      cache.set('a', '1')
      cache.set('b', '2')
      cache.set('c', '3')
      cache.set('d', '4') // should evict 'a'
      expect(cache.get('a')).toBeUndefined()
      expect(cache.get('b')).toBe('2')
      expect(cache.get('d')).toBe('4')
    })

    it('refreshes accessed entries', () => {
      cache.set('a', '1')
      cache.set('b', '2')
      cache.set('c', '3')
      cache.get('a') // refresh 'a', now 'b' is oldest
      cache.set('d', '4') // should evict 'b'
      expect(cache.get('a')).toBe('1')
      expect(cache.get('b')).toBeUndefined()
    })
  })

  describe('TTL expiration', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('returns value within TTL', () => {
      cache.set('key', 'value')
      vi.advanceTimersByTime(4999)
      expect(cache.get('key')).toBe('value')
    })

    it('expires entries after TTL', () => {
      cache.set('key', 'value')
      vi.advanceTimersByTime(5001)
      expect(cache.get('key')).toBeUndefined()
    })
  })
})
