/**
 * QR codes drawn as one SVG path (no canvas, no innerHTML). Used for the Captain pairing code.
 */
import { encode } from 'uqr'

export interface QrPath {
  /** Width and height in modules, quiet zone included. */
  size: number
  /** One 1×1 square per dark module, for `<path d=…>` in a `0 0 size size` viewBox. */
  d: string
}

/** Medium error correction: still reads off a glossy till screen with some glare. */
export function qrPath(text: string, border = 2): QrPath {
  const { size, data } = encode(text, { ecc: 'M', border })
  let d = ''
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) d += `M${x} ${y}h1v1h-1z`
    }),
  )
  return { size, d }
}
