const minuteMs = 60_000
const hourMs = 60 * minuteMs
const dayMs = 24 * hourMs

export type Range = { from: number; to: number }
export type Bucket = 'hour' | 'day'
export type Period = 'today' | '7d' | '30d'

export function readTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z][\w+-]*(?:\/[\w+-]+)*$/u.test(value)) return null
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

function offsetAt(formatter: Intl.DateTimeFormat, instant: number): number {
  const offset = formatter.formatToParts(instant).find(part => part.type === 'timeZoneName')?.value
  if (offset === 'GMT') return 0
  const match = offset?.match(/^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/u)
  if (!match) throw new Error('invalid_time_zone_offset')
  const [, sign, hours, minutes, seconds] = match
  return (sign === '-' ? -1 : 1) * (Number(hours) * hourMs + Number(minutes) * minuteMs + Number(seconds ?? 0) * 1_000)
}

function newOffsetAt(formatter: Intl.DateTimeFormat, lower: number, upper: number, offset: number): number {
  while (upper - lower > 1) {
    const midpoint = lower + Math.floor((upper - lower) / 2)
    if (offsetAt(formatter, midpoint) === offset) lower = midpoint
    else upper = midpoint
  }
  return upper
}

function nextBoundary(formatter: Intl.DateTimeFormat, start: number, grain: Bucket): number {
  const unit = grain === 'hour' ? hourMs : dayMs
  let instant = start
  for (;;) {
    const offset = offsetAt(formatter, instant)
    const wallBucket = Math.floor((instant + offset) / unit)
    const boundary = (wallBucket + 1) * unit - offset
    if (offsetAt(formatter, boundary) === offset) return boundary

    const change = newOffsetAt(formatter, instant, boundary, offset)
    if (grain === 'hour' || Math.floor((change + offsetAt(formatter, change)) / unit) !== wallBucket) return change
    instant = change
  }
}

export function createCalendar(timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'longOffset' })
  const wallTime = (instant: number) => instant + offsetAt(formatter, instant)

  return {
    period(period: Period, now: number): Range {
      const days = period === '7d' ? 7 : period === '30d' ? 30 : 1
      const firstDay = Math.floor(wallTime(now) / dayMs) - (days - 1)
      let from = (firstDay - 2) * dayMs
      while (Math.floor(wallTime(from) / dayMs) < firstDay) from = nextBoundary(formatter, from, 'day')
      return { from, to: now }
    },
    buckets(range: Range, bucket: Bucket): Range[] | null {
      const maxDays = bucket === 'hour' ? 31 : 366
      if (range.to - range.from > (maxDays + 2) * dayMs || wallTime(range.to) - wallTime(range.from) > maxDays * dayMs) {
        return null
      }
      const intervals: Range[] = []
      for (let from = range.from; from < range.to;) {
        const to = Math.min(nextBoundary(formatter, from, bucket), range.to)
        intervals.push({ from, to })
        from = to
      }
      return intervals
    },
    format(instant: number): string {
      const offset = offsetAt(formatter, instant)
      if (offset === 0 || offset % minuteMs !== 0) return new Date(instant).toISOString()
      const minutes = Math.abs(offset) / minuteMs
      const hoursText = String(Math.floor(minutes / 60)).padStart(2, '0')
      const minutesText = String(minutes % 60).padStart(2, '0')
      return `${new Date(instant + offset).toISOString().slice(0, -1)}${offset < 0 ? '-' : '+'}${hoursText}:${minutesText}`
    },
  }
}
