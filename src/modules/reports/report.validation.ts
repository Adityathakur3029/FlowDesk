import { z } from "zod";

// Validates GET /reports/overview and generates its OpenAPI parameters (see report.docs.ts).
// The range rules (from ≤ to, at most MAX_RANGE_DAYS) are business errors with codes, checked in resolvePeriod().
export const overviewReportQuerySchema = z.object({
  from: z.iso.date().meta({
    description: "First day of the period, YYYY-MM-DD (UTC), inclusive. Required.",
    example: "2025-10-21",
  }),
  to: z.iso.date().meta({
    description: "Last day of the period, YYYY-MM-DD (UTC), inclusive. Required. On or after `from`; may be in the future.",
    example: "2026-10-20",
  }),
});

export type OverviewReportQuery = z.infer<typeof overviewReportQuerySchema>;
