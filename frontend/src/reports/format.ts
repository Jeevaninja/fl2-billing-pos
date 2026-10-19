import type { Paise } from '../api/types'
import { formatPaise } from '../lib/money'

/** Display formatters shared by the Reports tabs. */

export const money = (p: Paise) => formatPaise(p)

const IST_TIME = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })

/** An ISO timestamp as IST "21:05". */
export const timeOf = (iso: string) => IST_TIME.format(new Date(iso))

const IST_STAMP = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })

/** "19 Oct 2026, 11:15 pm" for the print header. */
export const printStamp = (at: Date) => IST_STAMP.format(at)
