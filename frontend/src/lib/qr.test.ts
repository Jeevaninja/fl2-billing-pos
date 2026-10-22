import { describe, expect, it } from 'vitest'
import { encode } from 'uqr'
import { qrPath } from './qr'

describe('qrPath', () => {
  it('draws one square per dark module inside a quiet zone', () => {
    const text = '{"t":"fl2-captain-pair","v":1}'
    const { size, d } = qrPath(text)
    const { data } = encode(text, { ecc: 'M', border: 2 })
    const dark = data.flat().filter(Boolean).length
    expect(size).toBe(data.length)
    expect(d.match(/M/g)).toHaveLength(dark)
    // The quiet zone stays light: nothing is drawn in the first two rows or columns.
    expect(d).not.toMatch(/M[01] /)
    expect(d).not.toMatch(/M\d+ [01]h/)
  })
})
