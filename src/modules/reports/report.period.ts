import { BadRequestError } from "../../lib/errors";

// Date maths for the overview report. Every date is a UTC calendar date ("YYYY-MM-DD").
// See .claude/specs/09-overview-report.md

// Ranges up to this many days get weekly trend buckets, longer ones monthly
export const WEEKLY_MAX_DAYS = 92;
// Three years plus a leap day
export const MAX_RANGE_DAYS = 1096;

const DAY_MS = 86_400_000;

export type Granularity = "week" | "month";

export interface DateRange {
  from: string;
  to: string;
  days: number;
  // [start, end) instants of the range: from 00:00Z to the day after `to`, 00:00Z
  start: Date;
  end: Date;
}

export interface TrendBucket {
  // Start of the full week (Monday) or month, as Postgres date_trunc returns it
  key: string;
  // The bucket clipped to the period, both inclusive
  start: string;
  end: string;
}

export interface ReportPeriod {
  period: DateRange;
  previous: DateRange;
  granularity: Granularity;
  buckets: TrendBucket[];
  // Today's UTC date; overdue and at-risk compare against it
  asOf: string;
}

const toMs = (date: string) => Date.parse(`${date}T00:00:00Z`);

export const toIsoDate = (value: Date | number) => new Date(value).toISOString().slice(0, 10);

export const addDays = (date: string, days: number) => toIsoDate(toMs(date) + days * DAY_MS);

export const daysInclusive = (from: string, to: string) => Math.round((toMs(to) - toMs(from)) / DAY_MS) + 1;

function range(from: string, to: string): DateRange {
  return { from, to, days: daysInclusive(from, to), start: new Date(toMs(from)), end: new Date(toMs(addDays(to, 1))) };
}

// Monday of the ISO week, or the 1st of the month
function bucketStart(date: string, granularity: Granularity): string {
  if (granularity === "month") return `${date.slice(0, 7)}-01`;
  const weekday = new Date(toMs(date)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7));
}

function nextBucketStart(start: string, granularity: Granularity): string {
  if (granularity === "week") return addDays(start, 7);
  const d = new Date(toMs(start));
  return toIsoDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

// Buckets covering [from, to] exactly; the first and last may be partial
export function buildBuckets(from: string, to: string, granularity: Granularity): TrendBucket[] {
  const buckets: TrendBucket[] = [];
  for (let key = bucketStart(from, granularity); key <= to; key = nextBucketStart(key, granularity)) {
    const lastDay = addDays(nextBucketStart(key, granularity), -1);
    buckets.push({ key, start: key < from ? from : key, end: lastDay > to ? to : lastDay });
  }
  return buckets;
}

// Validates the requested range and derives everything else from it. `from`/`to` are
// already valid dates (Zod); YYYY-MM-DD strings compare correctly as text.
export function resolvePeriod(from: string, to: string, now: Date): ReportPeriod {
  if (from > to) throw new BadRequestError("from must be on or before to", "INVALID_DATE_RANGE");
  const days = daysInclusive(from, to);
  if (days > MAX_RANGE_DAYS) {
    throw new BadRequestError(`The report range can be at most ${MAX_RANGE_DAYS} days`, "DATE_RANGE_TOO_LONG");
  }

  const granularity: Granularity = days <= WEEKLY_MAX_DAYS ? "week" : "month";
  return {
    period: range(from, to),
    previous: range(addDays(from, -days), addDays(from, -1)),
    granularity,
    buckets: buildBuckets(from, to, granularity),
    asOf: toIsoDate(now),
  };
}
