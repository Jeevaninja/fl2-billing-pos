import { describe, expect, it } from 'vitest'
import { encodeJson, reviveJson } from '../api/client'
import { formatPaise, parseRupeesToPaise } from './money'

describe('formatPaise', () => {
  it.each([
    [0n, '₹0.00'],
    [5n, '₹0.05'],
    [102050n, '₹1,020.50'],
    [10_000_000n, '₹1,00,000.00'],
    [-22000n, '−₹220.00'],
    [123_456_789_012_345n, '₹12,34,56,78,90,123.45'],
  ])('%s paise → %s', (paise, text) => {
    expect(formatPaise(paise)).toBe(text)
  })
})

describe('parseRupeesToPaise', () => {
  it.each([
    ['1020.5', 102050n],
    ['1,020.50', 102050n],
    ['₹ 600', 60000n],
    ['0.05', 5n],
    ['0', 0n],
    ['  2200 ', 220000n],
  ])('%j → %s', (text, paise) => {
    expect(parseRupeesToPaise(text)).toBe(paise)
  })

  it.each(['', '.', '1.234', '-5', '1e3', 'abc', '12.3.4', '10..5'])('rejects %j', (text) => {
    expect(parseRupeesToPaise(text)).toBeNull()
  })
})

describe('API JSON money codec', () => {
  it('decodes every …Paise string to bigint and leaves other fields alone', () => {
    const decoded = JSON.parse(
      '{"totalPaise":"102050","billNo":7,"code":"123","items":[{"lineTotalPaise":"-22000"}],"creditLimitPaise":null}',
      reviveJson,
    )
    expect(decoded).toEqual({ totalPaise: 102050n, billNo: 7, code: '123', items: [{ lineTotalPaise: -22000n }], creditLimitPaise: null })
  })

  it('encodes bigint as decimal strings', () => {
    expect(encodeJson({ amount: 102050n, quantity: 2 })).toBe('{"amount":"102050","quantity":2}')
  })
})
