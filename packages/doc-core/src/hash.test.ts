import { describe, it, expect } from 'vitest'
import { contentHash } from './hash'

describe('contentHash', () => {
  it('produces a stable 64-char hex digest', async () => {
    const f = new File(['hello world'], 'a.txt')
    const h = await contentHash(f)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(await contentHash(new File(['hello world'], 'different-name.txt'))).toBe(h)
  })

  it('differs for different content', async () => {
    const a = await contentHash(new File(['one'], 'x.txt'))
    const b = await contentHash(new File(['two'], 'x.txt'))
    expect(a).not.toBe(b)
  })

  it('matches the known SHA-256 of its bytes', async () => {
    // Pinned so a change of algorithm or encoding cannot pass unnoticed.
    expect(await contentHash(new File(['abc'], 'abc.txt'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})
