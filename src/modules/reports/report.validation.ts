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
  scope: z.enum(["all", "programs", "boards"]).default("all").meta({
    description:
      "Which tasks the task numbers cover: `all` (default, program and board tasks), `programs` (program tasks only) or `boards` " +
      "(board tasks only). Program-only numbers (`totals.programs*`, `programsByStatus`, `teams`, `programs`) always cover programs, " +
      "and are 0 / empty under `boards`. `boards` rows are empty under `programs`.",
    example: "all",
  }),
});

export type OverviewReportQuery = z.infer<typeof overviewReportQuerySchema>;
export type ReportScope = OverviewReportQuery["scope"];
