import { z } from "zod";
import {
  authNote,
  bearerSecurity,
  errorResponseSchema,
  internalServerErrorResponse,
  jsonResponse,
  registry,
  unauthorizedResponse,
  validationErrorResponseSchema,
} from "../../docs/registry";
import { programStatusSchema } from "../programs/program.validation";
import { buildBuckets, MAX_RANGE_DAYS, WEEKLY_MAX_DAYS } from "./report.period";
import { overviewReportQuerySchema } from "./report.validation";

// Mirrors the object built in report.service.ts. Definitions: .claude/specs/09-overview-report.md,
// and for `scope` and board rows .claude/specs/10-boards.md

const count = (description: string) => z.number().int().min(0).meta({ description });
const isoDate = (description: string) => z.iso.date().meta({ description });

const periodSchema = registry.register(
  "ReportPeriod",
  z.object({
    from: isoDate("First day, inclusive (UTC)"),
    to: isoDate("Last day, inclusive (UTC)"),
    days: count("Number of days, both ends included"),
    granularity: z.enum(["week", "month"]).meta({
      description: `Trend bucket size: \`week\` when the period is at most ${WEEKLY_MAX_DAYS} days, otherwise \`month\``,
    }),
  }),
);

const previousPeriodSchema = registry.register(
  "ReportPreviousPeriod",
  z
    .object({
      from: isoDate("First day, inclusive"),
      to: isoDate("Last day, inclusive: the day before `period.from`"),
      days: count("Same as `period.days`"),
    })
    .meta({ description: "The same number of days, immediately before the period. Used for the `*Previous` deltas." }),
);

const totalsSchema = registry.register(
  "OverviewTotals",
  z
    .object({
      programs: count(
        "In-scope programs: active, created before the period ended, and not completed/cancelled before it started. 0 under `scope=boards`.",
      ),
      programsCompleted: count(
        "In-scope programs that are COMPLETED now with `completedAt` in the period (a program reopened since doesn't count). 0 under `scope=boards`.",
      ),
      programsAtRisk: count(
        "In-scope programs with an `endDate` before `asOf` that aren't COMPLETED or CANCELLED. Programs without an endDate are never at risk. " +
          "0 under `scope=boards`.",
      ),
      tasksCreated: count("Tasks in scope created in the period: tasks of every active program and/or every board task (event count)"),
      tasksCreatedPrevious: count("The same for the previous period"),
      tasksCompleted: count("Tasks in scope DONE now whose `completedAt` (last move to DONE) is in the period (event count)"),
      tasksCompletedPrevious: count("The same for the previous period"),
      tasksCompletedWithDueDate: count("Of `tasksCompleted`, those with a due date: the denominator of the on-time rate"),
      tasksCompletedOnTime: count("Of `tasksCompletedWithDueDate`, those whose completion date (UTC) is on or before the due date"),
      openTasks: count(
        "Snapshot tasks that aren't DONE, as of now: tasks of in-scope programs and/or every board task (including on deleted boards)",
      ),
      overdueTasks: count("Of `openTasks`, those with a due date before `asOf`"),
    })
    .meta({
      description:
        "Task numbers cover the tasks selected by `scope` (`all` = program and board tasks). Program numbers cover programs only.",
    }),
);

const programsByStatusSchema = registry.register(
  "ProgramsByStatus",
  z
    .object({
      PLANNED: count("In-scope programs PLANNED now"),
      ACTIVE: count("In-scope programs ACTIVE now"),
      ON_HOLD: count("In-scope programs ON_HOLD now"),
      COMPLETED: count("In-scope programs COMPLETED now"),
      CANCELLED: count("In-scope programs CANCELLED now"),
    })
    .meta({
      description:
        "In-scope programs by **current** status (there's no status history). Sums to `totals.programs`. Every key is 0 under `scope=boards`.",
    }),
);

const tasksByStatusSchema = registry.register(
  "TasksByStatus",
  z
    .object({
      DISCUSSION: count("In-scope tasks in DISCUSSION now"),
      ON_HOLD: count("In-scope tasks ON_HOLD now"),
      IN_PROGRESS: count("In-scope tasks IN_PROGRESS now"),
      DONE: count("In-scope tasks DONE now (completed on or after `period.from`)"),
      DEPENDENT: count("In-scope tasks DEPENDENT now"),
    })
    .meta({
      description:
        "Snapshot tasks in scope (tasks of in-scope programs and/or board tasks) that were live in the period (created before it ended, " +
        "and open or completed on/after `from`), by **current** status.",
    }),
);

const openTasksByPrioritySchema = registry.register(
  "OpenTasksByPriority",
  z
    .object({
      HIGHEST: count("Open HIGHEST tasks"),
      HIGH: count("Open HIGH tasks"),
      MEDIUM: count("Open MEDIUM tasks"),
      LOW: count("Open LOW tasks"),
      LOWEST: count("Open LOWEST tasks"),
    })
    .meta({ description: "`openTasks` by priority, as of now. Sums to `totals.openTasks`." }),
);

const trendBucketSchema = registry.register(
  "TrendBucket",
  z
    .object({
      start: isoDate("First day of the bucket, inclusive. The first bucket starts on `period.from`."),
      end: isoDate("Last day of the bucket, inclusive. The last bucket ends on `period.to`."),
      created: count("Tasks created in the bucket (same scope as `totals.tasksCreated`)"),
      completed: count("Tasks completed in the bucket (same scope as `totals.tasksCompleted`)"),
    })
    .meta({
      description:
        "One ISO week (Monday-Sunday) or calendar month, in UTC, clipped to the period. Buckets cover the period exactly and in order, " +
        "and are present even when zero.",
    }),
);

const teamRowSchema = registry.register(
  "TeamReportRow",
  z
    .object({
      teamId: z.uuid().nullable().meta({
        description: "null for the row grouping programs with no owner team (created before teams existed) or a deleted one",
      }),
      name: z.string().nullable().meta({ description: "Team name; null on the no-team row" }),
      programs: count("In-scope programs the team owns"),
      tasksCompleted: count("Tasks completed in the period in those programs"),
      openTasks: count("Open tasks in those programs, as of now"),
      overdueTasks: count("Overdue tasks in those programs, as of now"),
    })
    .meta({
      description:
        "Rolled up by program owner team; board tasks are never included. Teams owning no in-scope program are left out. " +
        "Empty under `scope=boards`.",
    }),
);

const programRowSchema = registry.register(
  "ProgramReportRow",
  z.object({
    id: z.uuid(),
    key: z.string(),
    name: z.string(),
    status: programStatusSchema,
    ownerTeam: z
      .object({ id: z.uuid(), name: z.string() })
      .nullable()
      .meta({ description: "null when the program has no owner team or it was deleted" }),
    startDate: z.iso.date().nullable(),
    endDate: z.iso.date().nullable(),
    completedAt: z.iso.datetime().nullable().meta({ description: "When the program became COMPLETED; null unless COMPLETED" }),
    tasksTotal: count("All live tasks in the program"),
    tasksDone: count("Tasks DONE now"),
    tasksCompletedInPeriod: count("Tasks completed in the period"),
    openTasks: count("Tasks not DONE, as of now"),
    overdueTasks: count("Open tasks with a due date before `asOf`"),
    atRisk: z.boolean().meta({ description: "`endDate` before `asOf` and status not COMPLETED/CANCELLED" }),
  }),
);

const boardRowSchema = registry.register(
  "BoardReportRow",
  z
    .object({
      id: z.uuid(),
      key: z.string(),
      name: z.string(),
      tasksTotal: count("All live tasks on the board"),
      tasksDone: count("Tasks DONE now"),
      tasksCompletedInPeriod: count("Tasks completed in the period"),
      openTasks: count("Tasks not DONE, as of now"),
      overdueTasks: count("Open tasks with a due date before `asOf`"),
    })
    .meta({
      description:
        "One active board with at least one live task. Boards never close, so every such board is listed whatever the period. " +
        "A soft-deleted board has no row, though its tasks still count in the totals.",
    }),
);

const overviewReportSchema = registry.register(
  "OverviewReport",
  z.object({
    period: periodSchema,
    previousPeriod: previousPeriodSchema,
    asOf: isoDate("Today's UTC date when the report was built. Overdue and at-risk compare against it, not against `period.to`."),
    totals: totalsSchema,
    programsByStatus: programsByStatusSchema,
    tasksByStatus: tasksByStatusSchema,
    openTasksByPriority: openTasksByPrioritySchema,
    trend: z.array(trendBucketSchema),
    teams: z.array(teamRowSchema).meta({
      description: "Ordered by name (ignoring case), then teamId; the no-team row (teamId null) last",
    }),
    programs: z.array(programRowSchema).meta({
      description:
        "Every in-scope program, unpaginated. Ordered: atRisk first, then overdueTasks descending, then name (ignoring case), then id. " +
        "Empty under `scope=boards`.",
    }),
    boards: z.array(boardRowSchema).meta({
      description:
        "Every active board with at least one live task, unpaginated. Ordered: overdueTasks descending, then name (ignoring case), then id. " +
        "Empty under `scope=programs`.",
    }),
  }),
);

const overviewResponseSchema = registry.register("OverviewReportResponse", z.object({ data: overviewReportSchema }));

// ---- Example: a 91-day period ending today, so weekly buckets ----

const createdPerWeek = [3, 4, 5, 4, 6, 3, 4, 5, 4, 5, 4, 5, 4, 2];
const completedPerWeek = [1, 2, 3, 2, 3, 2, 3, 3, 2, 4, 3, 4, 3, 2];
const researchTeam = { id: "3f2c8b1e-6d4a-4b7e-9c21-5a8e7d0f1b23", name: "Research" };
const operationsTeam = { id: "7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d", name: "Operations" };

const exampleReport = {
  period: { from: "2026-07-22", to: "2026-10-20", days: 91, granularity: "week" },
  previousPeriod: { from: "2026-04-22", to: "2026-07-21", days: 91 },
  asOf: "2026-10-20",
  totals: {
    programs: 4,
    programsCompleted: 1,
    programsAtRisk: 1,
    tasksCreated: 58,
    tasksCreatedPrevious: 41,
    tasksCompleted: 37,
    tasksCompletedPrevious: 30,
    tasksCompletedWithDueDate: 29,
    tasksCompletedOnTime: 22,
    openTasks: 51,
    overdueTasks: 9,
  },
  programsByStatus: { PLANNED: 1, ACTIVE: 2, ON_HOLD: 0, COMPLETED: 1, CANCELLED: 0 },
  tasksByStatus: { DISCUSSION: 13, ON_HOLD: 4, IN_PROGRESS: 24, DONE: 37, DEPENDENT: 10 },
  openTasksByPriority: { HIGHEST: 3, HIGH: 13, MEDIUM: 25, LOW: 8, LOWEST: 2 },
  trend: buildBuckets("2026-07-22", "2026-10-20", "week").map((b, i) => ({
    start: b.start,
    end: b.end,
    created: createdPerWeek[i],
    completed: completedPerWeek[i],
  })),
  teams: [
    { teamId: operationsTeam.id, name: operationsTeam.name, programs: 1, tasksCompleted: 10, openTasks: 18, overdueTasks: 3 },
    { teamId: researchTeam.id, name: researchTeam.name, programs: 2, tasksCompleted: 27, openTasks: 18, overdueTasks: 4 },
    { teamId: null, name: null, programs: 1, tasksCompleted: 0, openTasks: 8, overdueTasks: 0 },
  ],
  programs: [
    {
      id: "5b1f6a3e-8c1d-4f8e-9a51-2a7c3d9e0b14",
      key: "MKT",
      name: "Marketing Research",
      status: "ACTIVE",
      ownerTeam: researchTeam,
      startDate: "2026-07-01",
      endDate: "2026-10-15",
      completedAt: null,
      tasksTotal: 40,
      tasksDone: 22,
      tasksCompletedInPeriod: 18,
      openTasks: 18,
      overdueTasks: 4,
      atRisk: true,
    },
    {
      id: "c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f",
      key: "OPS",
      name: "Operations Revamp",
      status: "ACTIVE",
      ownerTeam: operationsTeam,
      startDate: "2026-08-01",
      endDate: "2026-12-31",
      completedAt: null,
      tasksTotal: 30,
      tasksDone: 12,
      tasksCompletedInPeriod: 10,
      openTasks: 18,
      overdueTasks: 3,
      atRisk: false,
    },
    {
      id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
      key: "ONB",
      name: "Onboarding Guide",
      status: "PLANNED",
      ownerTeam: null,
      startDate: null,
      endDate: null,
      completedAt: null,
      tasksTotal: 8,
      tasksDone: 0,
      tasksCompletedInPeriod: 0,
      openTasks: 8,
      overdueTasks: 0,
      atRisk: false,
    },
    {
      id: "1e2d3c4b-5a69-4788-9a0b-c1d2e3f4a5b6",
      key: "SRV",
      name: "Survey Program",
      status: "COMPLETED",
      ownerTeam: researchTeam,
      startDate: "2026-06-01",
      endDate: "2026-09-30",
      completedAt: "2026-09-29T16:20:00.000Z",
      tasksTotal: 9,
      tasksDone: 9,
      tasksCompletedInPeriod: 9,
      openTasks: 0,
      overdueTasks: 0,
      atRisk: false,
    },
  ],
  boards: [
    {
      id: "8c7d6e5f-4a3b-4c2d-9e1f-0a9b8c7d6e5f",
      key: "PRO",
      name: "Product feedback",
      tasksTotal: 7,
      tasksDone: 0,
      tasksCompletedInPeriod: 0,
      openTasks: 7,
      overdueTasks: 2,
    },
  ],
};

const description = [
  "Organisation-wide numbers for a date range, for the leadership Overview page. Computed on every request, in SQL, " +
    "from one consistent snapshot.",
  "**Period.** `from` and `to` are UTC calendar dates, both inclusive: the period is `[from 00:00Z, to + 1 day 00:00Z)`. " +
    "`to` may be in the future and isn't clamped (future buckets are zero). `previousPeriod` has the same number of days and ends " +
    "the day before `from`. `asOf` is today's UTC date; overdue and at-risk compare against it.",
  "**Definitions.**\n" +
    "- *In-scope program*: not deleted, created before the period ended, and not finished before it started " +
    "(finished = `completedAt` or `cancelledAt`).\n" +
    "- *Open task*: status isn't DONE (DEPENDENT counts as open). *Overdue*: open with a due date before `asOf`; tasks without a due date are never overdue.\n" +
    "- *Completed in a window*: DONE now with `completedAt` in the window. `completedAt` is the **last** move to DONE, so a task finished, " +
    "reopened and finished again counts once.\n" +
    "- *On time*: completed in the period with a due date, and the completion date (UTC) on or before it. Tasks without a due date are left " +
    "out of both `tasksCompletedOnTime` and `tasksCompletedWithDueDate`.\n" +
    "- *At risk*: an in-scope program with an `endDate` before `asOf` that isn't COMPLETED or CANCELLED.",
  "**Scope.** `scope` picks the tasks behind every task number: `all` (default) = program tasks and board tasks, `programs` = program " +
    "tasks only, `boards` = board tasks only. Board tasks always count, **even on a soft-deleted board** (boards never close; deleting one " +
    "hides only the board). Program-only numbers (`totals.programs`, `programsCompleted`, `programsAtRisk`, `programsByStatus`, `teams`, " +
    "`programs`) always cover programs; they are the same under `all` and `programs`, and 0 / empty under `boards`. `boards` is empty " +
    "under `programs`. The response shape never changes.",
  "**Two task scopes.** Event counts (`tasksCreated*`, `tasksCompleted*`, `trend`) count every live task in every non-deleted program, " +
    "plus every live board task, so the previous-period deltas compare like with like. Snapshot and breakdown counts (`openTasks`, " +
    "`overdueTasks`, `tasksByStatus`, `openTasksByPriority`, `teams`, `programs`, `boards`) count only tasks of in-scope programs, plus every " +
    "live board task. The sums of `programs[].tasksCompletedInPeriod` and `teams[].tasksCompleted` can therefore be lower than " +
    "`totals.tasksCompleted`, but only when tasks were completed in a program that had already finished before the period.",
  "**What adds up.** `trend` sums to the created/completed totals. `openTasksByPriority` sums to `totals.openTasks`. " +
    "`programs[].openTasks + boards[].openTasks` equals `totals.openTasks` (and the same for `overdueTasks`), except for open tasks on " +
    "soft-deleted boards, which count in the totals but have no row. `teams[].openTasks` sums to `programs[].openTasks`.",
  "**Statuses are current.** There's no status history, so `programsByStatus` and `tasksByStatus` use each row's status now, and the " +
    "open/overdue numbers are as of now even when `to` is in the past.",
  `**Trend.** Weekly (ISO weeks, Monday-Sunday) when the period is at most ${WEEKLY_MAX_DAYS} days, otherwise monthly; in UTC. ` +
    "Buckets cover the period exactly: the first starts on `from` and the last ends on `to`, so either may be partial.",
  "Soft-deleted programs and tasks are excluded everywhere (soft-deleted boards aren't: only their row is). An empty organisation or " +
    "range returns zeros, every status and priority key, empty `teams`, `programs` and `boards`, and the trend buckets.",
  authNote(),
].join("\n\n");

const badRequest = {
  description:
    "`Validation failed`: `from` or `to` is missing, repeated, or not a real `YYYY-MM-DD` date (`details[].path` is `from` or `to`), " +
    "or `scope` isn't `all`, `programs` or `boards`. " +
    `\`INVALID_DATE_RANGE\`: \`from\` is after \`to\`. \`DATE_RANGE_TOO_LONG\`: the range is more than ${MAX_RANGE_DAYS} days, both ends included.`,
  content: {
    "application/json": {
      schema: z.union([validationErrorResponseSchema, errorResponseSchema]),
      examples: {
        missing: {
          value: {
            error: "Validation failed",
            details: [{ path: "to", message: "Invalid input: expected string, received undefined" }],
          },
        },
        badFormat: { value: { error: "Validation failed", details: [{ path: "from", message: "Invalid ISO date" }] } },
        badScope: {
          value: {
            error: "Validation failed",
            details: [{ path: "scope", message: 'Invalid option: expected one of "all"|"programs"|"boards"' }],
          },
        },
        invalidDateRange: { value: { error: "from must be on or before to", code: "INVALID_DATE_RANGE" } },
        tooLong: {
          value: { error: `The report range can be at most ${MAX_RANGE_DAYS} days`, code: "DATE_RANGE_TOO_LONG" },
        },
      },
    },
  },
};

registry.registerPath({
  method: "get",
  path: "/reports/overview",
  tags: ["Reports"],
  summary: "Organisation overview for a date range",
  description,
  security: bearerSecurity,
  request: { query: overviewReportQuerySchema },
  responses: {
    200: jsonResponse("The overview report", overviewResponseSchema, { data: exampleReport }),
    400: badRequest,
    401: unauthorizedResponse,
    500: internalServerErrorResponse,
  },
});
