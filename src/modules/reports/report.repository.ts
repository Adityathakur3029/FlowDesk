import { and, eq, gte, isNotNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db, type DbExecutor } from "../../db";
import { programs, tasks, teams, type TaskPriority, type TaskStatus } from "../../db/schema";
import type { DateRange, Granularity } from "./report.period";

// Aggregate queries behind GET /reports/overview. Soft-deleted programs and tasks are
// excluded everywhere. Definitions: .claude/specs/09-overview-report.md

const countWhere = (cond: SQL | undefined) => sql<number>`cast(count(*) filter (where ${cond}) as int)`;
const countAll = sql<number>`cast(count(*) as int)`;

const inWindow = (column: PgColumn, window: DateRange) => and(gte(column, window.start), lt(column, window.end));

const isOpen = ne(tasks.status, "DONE");
const createdIn = (window: DateRange) => inWindow(tasks.createdAt, window);
const completedIn = (window: DateRange) => and(eq(tasks.status, "DONE"), inWindow(tasks.completedAt, window));

// Active, created before the period ends, and not finished before it starts
function inScopeProgram(period: DateRange): SQL {
  const finishedAt = sql`coalesce(${programs.completedAt}, ${programs.cancelledAt})`;
  return and(
    eq(programs.isActive, true),
    lt(programs.createdAt, period.end),
    sql`(${finishedAt} is null or ${finishedAt} >= ${period.start})`,
  )!;
}

const activeProgramOfTask = and(eq(programs.id, tasks.programId), eq(programs.isActive, true));

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
  function countPerBucket(column: PgColumn, cond: SQL | undefined, granularity: Granularity) {
    const bucket = sql<string>`to_char(date_trunc(${sql.raw(`'${granularity}'`)}, ${column} at time zone 'UTC'), 'YYYY-MM-DD')`;
    return executor
      .select({ bucket, count: countAll })
      .from(tasks)
      .innerJoin(programs, activeProgramOfTask)
      .where(and(eq(tasks.isActive, true), cond))
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
          overdueTasks: countWhere(and(isOpen, lt(tasks.dueDate, asOf))),
        })
        .from(programs)
        .leftJoin(teams, and(eq(teams.id, programs.ownerTeamId), eq(teams.isActive, true)))
        .leftJoin(tasks, and(eq(tasks.programId, programs.id), eq(tasks.isActive, true)))
        .where(inScopeProgram(period))
        .groupBy(programs.id, teams.id);
    },

    // Created/completed counts over every live task, for the period and the previous one
    async taskEventTotals(period: DateRange, previous: DateRange): Promise<TaskEventTotals> {
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
        .innerJoin(programs, activeProgramOfTask)
        .where(and(eq(tasks.isActive, true), or(createdIn(both), inWindow(tasks.completedAt, both))));
      return row!;
    },

    // Tasks of in-scope programs that were live in the period, by current status
    tasksByStatus(period: DateRange): Promise<{ status: TaskStatus; count: number }[]> {
      return executor
        .select({ status: tasks.status, count: countAll })
        .from(tasks)
        .innerJoin(programs, eq(programs.id, tasks.programId))
        .where(
          and(
            inScopeProgram(period),
            eq(tasks.isActive, true),
            lt(tasks.createdAt, period.end),
            or(isOpen, gte(tasks.completedAt, period.start)),
          ),
        )
        .groupBy(tasks.status);
    },

    // Open tasks of in-scope programs, as of now, by priority
    openTasksByPriority(period: DateRange): Promise<{ priority: TaskPriority; count: number }[]> {
      return executor
        .select({ priority: tasks.priority, count: countAll })
        .from(tasks)
        .innerJoin(programs, eq(programs.id, tasks.programId))
        .where(and(inScopeProgram(period), eq(tasks.isActive, true), isOpen))
        .groupBy(tasks.priority);
    },

    createdPerBucket(period: DateRange, granularity: Granularity) {
      return countPerBucket(tasks.createdAt, createdIn(period), granularity);
    },

    completedPerBucket(period: DateRange, granularity: Granularity) {
      return countPerBucket(tasks.completedAt, completedIn(period), granularity);
    },
  };
}

export const reportRepository = createReportRepository();
