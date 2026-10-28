import {
  and,
  arrayOverlaps,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { createRepository } from "../../db/repository";
import { boards, employees, programs, taskDependencies, tasks, type Task } from "../../db/schema";
import { db, type DbExecutor } from "../../db";
import { likeContains } from "../programs/program.repository";
import { parentWhere, type TaskParent } from "./task.parent";
import { isUuid, type ListTasksQuery } from "./task.validation";

export interface EmployeeSummary {
  id: string;
  name: string;
  emailId: string;
}

// The program or board a task belongs to. isActive is false only for a deleted board
// (a deleted program's tasks aren't returned at all).
export interface TaskParentSummary {
  type: "PROGRAM" | "BOARD";
  id: string;
  key: string;
  name: string;
  isActive: boolean;
}

// A task with its people, its parent and the computed isDependent flag (what the API returns)
export interface TaskView {
  task: Task;
  assignee: EmployeeSummary | null;
  reporter: EmployeeSummary;
  parent: TaskParentSummary;
  isDependent: boolean;
}

export interface TaskListFilters extends ListTasksQuery {
  // `me` already resolved to the signed-in employee's id
  assigneeId?: string;
  reporterId?: string;
}

const assignee = alias(employees, "assignee");
const reporter = alias(employees, "reporter");

// Links only ever point at active tasks (they're deleted with the task), so any link counts
const isDependentSql = sql<boolean>`exists (select 1 from ${taskDependencies} where ${taskDependencies.taskId} = ${tasks.id})`;

// A task by UUID or key (keys are stored uppercase and unique across FlowDesk)
const refMatch = (ref: string): SQL => (isUuid(ref) ? eq(tasks.id, ref) : eq(tasks.key, ref.toUpperCase()));

// 00:00Z of a YYYY-MM-DD date, plus whole days
const utcDayStart = (date: string, plusDays = 0) => new Date(Date.parse(`${date}T00:00:00Z`) + plusDays * 86_400_000);

const sortColumns = {
  number: tasks.number,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
  dueDate: tasks.dueDate,
  priority: tasks.priority,
  type: tasks.type,
} as const;

// Generic CRUD from createRepository plus joined reads for the API
export function createTaskRepository(executor: DbExecutor = db) {
  const base = createRepository(tasks, executor);

  const selectViews = () =>
    executor
      .select({
        task: tasks,
        assignee: { id: assignee.id, name: assignee.name, emailId: assignee.emailId },
        reporter: { id: reporter.id, name: reporter.name, emailId: reporter.emailId },
        program: { id: programs.id, key: programs.key, name: programs.name, isActive: programs.isActive },
        board: { id: boards.id, key: boards.key, name: boards.name, isActive: boards.isActive },
        isDependent: isDependentSql,
      })
      .from(tasks)
      .leftJoin(assignee, eq(assignee.id, tasks.assigneeId))
      .innerJoin(reporter, eq(reporter.id, tasks.reporterId))
      .leftJoin(programs, eq(programs.id, tasks.programId))
      .leftJoin(boards, eq(boards.id, tasks.boardId));

  const toView = (row: Awaited<ReturnType<typeof selectViews>>[number]): TaskView => ({
    task: row.task,
    assignee: row.assignee?.id ? row.assignee : null,
    reporter: row.reporter,
    // Exactly one of them is set (tasks_single_parent_check)
    parent: row.program?.id ? { type: "PROGRAM", ...row.program } : { type: "BOARD", ...row.board! },
    isDependent: Boolean(row.isDependent),
  });

  const listWhere = (parent: TaskParent, f: TaskListFilters): SQL =>
    and(
      parentWhere(tasks, parent),
      eq(tasks.isActive, true),
      f.status ? inArray(tasks.status, f.status) : undefined,
      f.priority ? inArray(tasks.priority, f.priority) : undefined,
      f.type ? inArray(tasks.type, f.type) : undefined,
      f.assigneeId ? eq(tasks.assigneeId, f.assigneeId) : undefined,
      f.unassigned === true ? isNull(tasks.assigneeId) : undefined,
      f.unassigned === false ? sql`${tasks.assigneeId} is not null` : undefined,
      f.reporterId ? eq(tasks.reporterId, f.reporterId) : undefined,
      f.label ? arrayOverlaps(tasks.labels, f.label) : undefined,
      f.dueFrom ? gte(tasks.dueDate, f.dueFrom) : undefined,
      f.dueTo ? lte(tasks.dueDate, f.dueTo) : undefined,
      // Bounds on the timestamp (not on its date) so tasks_created_at_idx can be used
      f.createdFrom ? gte(tasks.createdAt, utcDayStart(f.createdFrom)) : undefined,
      f.createdTo ? lt(tasks.createdAt, utcDayStart(f.createdTo, 1)) : undefined,
      f.isDependent === true ? isDependentSql : undefined,
      f.isDependent === false ? sql`not ${isDependentSql}` : undefined,
      f.q ? or(ilike(tasks.title, likeContains(f.q)), eq(tasks.key, f.q.toUpperCase())) : undefined,
    )!;

  return {
    ...base,
    withTx: (tx: DbExecutor) => createTaskRepository(tx),

    // Active task with this parent by UUID or key (case-insensitive)
    findByRef(parent: TaskParent, ref: string): Promise<Task | undefined> {
      return base.findOne(and(parentWhere(tasks, parent), refMatch(ref))!);
    },

    // Active task by UUID or key, whatever its parent (/tasks/:taskRef). A program task needs an
    // active program; a board task is reachable even when its board is deleted.
    async findReachableByRef(ref: string): Promise<Task | undefined> {
      const [row] = await executor
        .select({ task: tasks })
        .from(tasks)
        .leftJoin(programs, eq(programs.id, tasks.programId))
        .where(and(refMatch(ref), eq(tasks.isActive, true), or(isNotNull(tasks.boardId), eq(programs.isActive, true))))
        .limit(1);
      return row?.task;
    },

    // Next global task number. Not transactional: a rolled-back create leaves a gap, never a reuse.
    async nextNumber(): Promise<number> {
      const result = await executor.execute<{ n: number }>(sql`SELECT nextval('task_number_seq')::int AS n`);
      return result.rows[0]!.n;
    },

    async findViewById(id: string): Promise<TaskView | undefined> {
      const [row] = await selectViews().where(and(eq(tasks.id, id), eq(tasks.isActive, true)));
      return row ? toView(row) : undefined;
    },

    async listViews(parent: TaskParent, filters: TaskListFilters) {
      const where = listWhere(parent, filters);
      const dir = filters.order === "asc" ? asc : desc;
      const sortColumn = sortColumns[filters.sort];
      // Tasks without a due date go last in both directions
      const primary =
        filters.sort === "dueDate" ? sql`${tasks.dueDate} ${sql.raw(filters.order)} nulls last` : dir(sortColumn);
      const orderBy = filters.sort === "number" ? [primary] : [primary, dir(tasks.number)];

      const [rows, [total]] = await Promise.all([
        selectViews()
          .where(where)
          .orderBy(...orderBy)
          .limit(filters.limit)
          .offset(filters.offset),
        executor.select({ value: count() }).from(tasks).where(where),
      ]);
      return { items: rows.map(toView), total: total?.value ?? 0, limit: filters.limit, offset: filters.offset };
    },

    // Distinct labels on the program's or board's active tasks with usage counts
    async labelStats(parent: TaskParent): Promise<Array<{ label: string; taskCount: number }>> {
      const result = await executor.execute<{ label: string; task_count: string }>(sql`
        SELECT label, count(*) AS task_count
        FROM ${tasks}, unnest(${tasks.labels}) AS label
        WHERE ${parentWhere(tasks, parent)} AND ${tasks.isActive} = true
        GROUP BY label
        ORDER BY task_count DESC, label ASC
      `);
      return result.rows.map((r) => ({ label: r.label, taskCount: Number(r.task_count) }));
    },
  };
}

export const taskRepository = createTaskRepository();
