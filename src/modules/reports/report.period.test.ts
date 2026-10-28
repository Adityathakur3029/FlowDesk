import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AppError } from "../../lib/errors";
import { addDays, buildBuckets, MAX_RANGE_DAYS, resolvePeriod } from "./report.period";

const NOW = new Date("2026-10-20T12:00:00Z");

const errorCode = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof AppError ? `${err.statusCode} ${err.code}` : String(err);
  }
  return "no error";
};

describe("resolvePeriod", () => {
  test("previous period has the same length and ends the day before from", () => {
    const p = resolvePeriod("2026-10-01", "2026-10-31", NOW);
    assert.equal(p.period.days, 31);
    assert.deepEqual([p.previous.from, p.previous.to, p.previous.days], ["2026-08-31", "2026-09-30", 31]);
    assert.equal(p.period.start.toISOString(), "2026-10-01T00:00:00.000Z");
    assert.equal(p.period.end.toISOString(), "2026-11-01T00:00:00.000Z");
    assert.equal(p.previous.end.getTime(), p.period.start.getTime());
  });

  test("previous period across a year and a leap day", () => {
    const p = resolvePeriod("2024-03-01", "2024-03-31", NOW);
    assert.deepEqual([p.previous.from, p.previous.to], ["2024-01-30", "2024-02-29"]);
  });

  test("a single day is a valid range", () => {
    const p = resolvePeriod("2026-10-20", "2026-10-20", NOW);
    assert.equal(p.period.days, 1);
    assert.deepEqual(p.buckets, [{ key: "2026-10-19", start: "2026-10-20", end: "2026-10-20" }]);
  });

  test("granularity is week up to 92 days, month beyond", () => {
    assert.equal(resolvePeriod("2026-01-01", addDays("2026-01-01", 91), NOW).granularity, "week");
    assert.equal(resolvePeriod("2026-01-01", addDays("2026-01-01", 92), NOW).granularity, "month");
  });

  test("from after to is INVALID_DATE_RANGE", () => {
    assert.equal(errorCode(() => resolvePeriod("2026-10-02", "2026-10-01", NOW)), "400 INVALID_DATE_RANGE");
  });

  test(`at most ${MAX_RANGE_DAYS} days`, () => {
    assert.equal(resolvePeriod("2023-01-01", addDays("2023-01-01", MAX_RANGE_DAYS - 1), NOW).period.days, MAX_RANGE_DAYS);
    assert.equal(errorCode(() => resolvePeriod("2023-01-01", addDays("2023-01-01", MAX_RANGE_DAYS), NOW)), "400 DATE_RANGE_TOO_LONG");
  });

  test("asOf is today's UTC date", () => {
    assert.equal(resolvePeriod("2026-01-01", "2026-01-31", new Date("2026-10-20T23:30:00-05:00")).asOf, "2026-10-21");
  });
});

describe("buildBuckets", () => {
  test("weeks run Monday to Sunday; first and last are partial", () => {
    // 2026-07-22 is a Wednesday, 2026-08-04 a Tuesday
    assert.deepEqual(buildBuckets("2026-07-22", "2026-08-04", "week"), [
      { key: "2026-07-20", start: "2026-07-22", end: "2026-07-26" },
      { key: "2026-07-27", start: "2026-07-27", end: "2026-08-02" },
      { key: "2026-08-03", start: "2026-08-03", end: "2026-08-04" },
    ]);
  });

  test("a range starting on a Monday has a full first week", () => {
    assert.deepEqual(buildBuckets("2026-07-27", "2026-08-02", "week"), [
      { key: "2026-07-27", start: "2026-07-27", end: "2026-08-02" },
    ]);
  });

  test("months are calendar months, including February in a leap year", () => {
    assert.deepEqual(buildBuckets("2024-01-15", "2024-03-10", "month"), [
      { key: "2024-01-01", start: "2024-01-15", end: "2024-01-31" },
      { key: "2024-02-01", start: "2024-02-01", end: "2024-02-29" },
      { key: "2024-03-01", start: "2024-03-01", end: "2024-03-10" },
    ]);
  });

  test("buckets cover the period exactly, with no gaps or overlaps", () => {
    for (const [from, to, g] of [
      ["2025-10-21", "2026-10-20", "month"],
      ["2026-07-22", "2026-10-20", "week"],
      ["2023-10-21", "2026-10-20", "month"],
    ] as const) {
      const buckets = buildBuckets(from, to, g);
      assert.equal(buckets[0]!.start, from);
      assert.equal(buckets.at(-1)!.end, to);
      for (let i = 1; i < buckets.length; i++) assert.equal(buckets[i]!.start, addDays(buckets[i - 1]!.end, 1));
    }
    assert.equal(buildBuckets("2025-10-21", "2026-10-20", "month").length, 13);
    assert.equal(buildBuckets("2026-07-22", "2026-10-20", "week").length, 14);
  });
});
