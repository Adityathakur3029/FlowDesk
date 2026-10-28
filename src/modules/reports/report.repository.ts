import { and, eq, gte, isNotNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db, type DbExecutor } from "../../db";
import { boards, programs, tasks, teams, type TaskPriority, type TaskStatus } from "../../db/schema";
import type { DateRange, Granularity } from "./report.period";
import type { ReportScope } from "./report.validation";

// Aggregate queries behind GET /reports/overview. Soft-deleted programs and tasks are excluded
// everywhere; board tasks count even when their board is deleted (boards never close).
// Definitions: .claude/specs/09-overview-report.md and .claude/specs/10-boards.md

const countWhere = (cond: SQL | undefined) => sql<number>`cast(count(*) filter (where ${cond}) as int)`;
const countAll = sql<number>`cast(count(*) as int)`;

const inWindow = (column: PgColumn, window: DateRange) => and(gte(column, window.start), lt(column, window.end));

const isOpen = ne(tasks.status, "DONE");
const createdIn = (window: DateRange) => inWindow(tasks.createdAt, window);
const completedIn = (window: DateRange) => and(eq(tasks.status, "DONE"), inWindow(tasks.completedAt, window));
const isOverdue = (asOf: string) => and(isOpen, lt(tasks.dueDate, asOf));

// Active, created before the period ends, and not finished before it starts
function inScopeProgram(period: DateRange): SQL {
  const finishedAt = sql`coalesce(${programs.completedAt}, ${programs.cancelledAt})`;
  return and(
    eq(programs.isActive, true),
    lt(programs.createdAt, period.end),
    sql`(${finishedAt} is null or ${finishedAt} >= ${period.start})`,
  )!;
}

// Live tasks in the scope. Program tasks must also meet `programCond` (on the left-joined program);
// board tasks have no board condition.
function liveTasksIn(scope: ReportScope, programCond: SQL): SQL {
  const programTask = and(isNotNull(tasks.programId), programCond)!;
  const boardTask = isNotNull(tasks.boardId);
  const inScope = scope === "programs" ? programTask : scope === "boards" ? boardTask : or(programTask, boardTask);
  return and(eq(tasks.isActive, true), inScope)!;
}

// Event counts: every live task of an active program, plus every live board task
const eventTasks = (scope: ReportScope) => liveTasksIn(scope, eq(programs.isActive, true));
// Snapshots and breakdowns: tasks of in-scope programs, plus every live board task
const snapshotTasks = (scope: ReportScope, period: DateRange) => liveTasksIn(scope, inScopeProgram(period));

const programOfTask = eq(programs.id, tasks.programId);

export interface ProgramReportRow {
  id: string;
  key: string;
  name: string;
  status: (typeof programs.$inferSelect)["status"];
  startDate: string | null;
  endDate: string | null;
  completedAt: Date | null;
  ownerTeamId: string | null;
  ownerTeamName: string | null;
  tasksTotal: number;
  tasksDone: number;
  tasksCompletedInPeriod: number;
  openTasks: number;
  overdueTasks: number;
}

export interface BoardReportRow {
  id: string;
  key: string;
  name: string;
  tasksTotal: number;
  tasksDone: number;
  tasksCompletedInPeriod: number;
  openTasks: number;
  overdueTasks: number;
}

export interface TaskEventTotals {
  created: number;
  createdPrevious: number;
  completed: number;
  completedPrevious: number;
  completedWithDueDate: number;
  completedOnTime: number;
}

export function createReportRepository(executor: DbExecutor = db) {
  // Tasks created or completed per trend bucket. The unit is a fixed literal, not a
  // parameter, so the SELECT and GROUP BY expressions are identical.
  function countPerBucket(column: PgColumn, cond: SQL | undefined, granularity: Granularity, scope: ReportScope) {
    const bucket = sql<string>`to_char(date_trunc(${sql.raw(`'${granularity}'`)}, ${column} at time zone 'UTC'), 'YYYY-MM-DD')`;
    return executor
      .select({ bucket, count: countAll })
      .from(tasks)
      .leftJoin(programs, programOfTask)
      .where(and(eventTasks(scope), cond))
      .groupBy(bucket);
  }

  return {
    withTx: (tx: DbExecutor) => createReportRepository(tx),

    // One row per in-scope program with its task counts; ownerTeam* null when the team is missing or deleted
    programRows(period: DateRange, asOf: string): Promise<ProgramReportRow[]> {
      return executor
        .select({
          id: programs.id,
          key: programs.key,
          name: programs.name,
          status: programs.status,
          startDate: programs.startDate,
          endDate: programs.endDate,
          completedAt: programs.completedAt,
          ownerTeamId: teams.id,
          ownerTeamName: teams.name,
          tasksTotal: countWhere(isNotNull(tasks.id)),
          tasksDone: countWhere(eq(tasks.status, "DONE")),
          tasksCompletedInPeriod: countWhere(completedIn(period)),
          openTasks: countWhere(isOpen),
          overdueTasks: countWhere(isOverdue(asOf)),
        })
        .from(programs)
        .leftJoin(teams, and(eq(teams.id, programs.ownerTeamId), eq(teams.isActive, true)))
        .leftJoin(tasks, and(eq(tasks.programId, programs.id), eq(tasks.isActive, true)))
        .where(inScopeProgram(period))
        .groupBy(programs.id, teams.id);
    },

    // One row per active board with at least one live task. Deleted boards have no row,
    // though their tasks still count in the totals.
    boardRows(period: DateRange, asOf: string): Promise<BoardReportRow[]> {
      return executor
        .select({
          id: boards.id,
          key: boards.key,
          name: boards.name,
          tasksTotal: countAll,
          tasksDone: countWhere(eq(tasks.status, "DONE")),
          tasksCompletedInPeriod: countWhere(completedIn(period)),
          openTasks: countWhere(isOpen),
          overdueTasks: countWhere(isOverdue(asOf)),
        })
        .from(boards)
        .innerJoin(tasks, and(eq(tasks.boardId, boards.id), eq(tasks.isActive, true)))
        .where(eq(boards.isActive, true))
        .groupBy(boards.id);
    },

    // Created/completed counts over every live task in scope, for the period and the previous one
    async taskEventTotals(period: DateRange, previous: DateRange, scope: ReportScope): Promise<TaskEventTotals> {
      const both = { ...period, start: previous.start }; // previous ends where period starts
      const completedInPeriod = completedIn(period);
      const [row] = await executor
        .select({
          created: countWhere(createdIn(period)),
          createdPrevious: countWhere(createdIn(previous)),
          completed: countWhere(completedInPeriod),
          completedPrevious: countWhere(completedIn(previous)),
          completedWithDueDate: countWhere(and(completedInPeriod, isNotNull(tasks.dueDate))),
          completedOnTime: countWhere(
            and(completedInPeriod, sql`(${tasks.completedAt} at time zone 'UTC')::date <= ${tasks.dueDate}`),
          ),
        })
        .from(tasks)
        .leftJoin(programs, programOfTask)
        .where(and(eventTasks(scope), or(createdIn(both), inWindow(tasks.completedAt, both))));
      return row!;
    },

    // Snapshot tasks that were live in the period, by current status
    tasksByStatus(period: DateRange, scope: ReportScope): Promise<{ status: TaskStatus; count: number }[]> {
      return executor
        .select({ status: tasks.status, count: countAll })
        .from(tasks)
        .leftJoin(programs, programOfTask)
        .where(
          and(
            snapshotTasks(scope, period),
            lt(tasks.createdAt, period.end),
            or(isOpen, gte(tasks.completedAt, period.start)),
          ),
        )
        .groupBy(tasks.status);
    },

    // Open snapshot tasks, as of now, by priority, with how many of them are overdue.
    // Their sums are totals.openTasks / overdueTasks (deleted boards' tasks have no row to sum).
    openTasksByPriority(
      period: DateRange,
      asOf: string,
      scope: ReportScope,
    ): Promise<{ priority: TaskPriority; count: number; overdue: number }[]> {
      return executor
        .select({ priority: tasks.priority, count: countAll, overdue: countWhere(isOverdue(asOf)) })
        .from(tasks)
        .leftJoin(programs, programOfTask)
        .where(and(snapshotTasks(scope, period), isOpen))
        .groupBy(tasks.priority);
    },

    createdPerBucket(period: DateRange, granularity: Granularity, scope: ReportScope) {
      return countPerBucket(tasks.createdAt, createdIn(period), granularity, scope);
    },

    completedPerBucket(period: DateRange, granularity: Granularity, scope: ReportScope) {
      return countPerBucket(tasks.completedAt, completedIn(period), granularity, scope);
    },
  };
}

export const reportRepository = createReportRepository();
