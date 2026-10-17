import { and, arrayOverlaps, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { createRepository } from "../../db/repository";
import { employees, taskDependencies, tasks, type Task } from "../../db/schema";
import { db, type DbExecutor } from "../../db";
import { likeContains } from "../programs/program.repository";
import { isUuid, type ListTasksQuery } from "./task.validation";

export interface EmployeeSummary {
  id: string;
  name: string;
  emailId: string;
}

// A task with its people and the computed isDependent flag (what the API returns)
export interface TaskView {
  task: Task;
  assignee: EmployeeSummary | null;
  reporter: EmployeeSummary;
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

const sortColumns = {
  number: tasks.number,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
  dueDate: tasks.dueDate,
  priority: tasks.priority,
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
        isDependent: isDependentSql,
      })
      .from(tasks)
      .leftJoin(assignee, eq(assignee.id, tasks.assigneeId))
      .innerJoin(reporter, eq(reporter.id, tasks.reporterId));

  const toView = (row: Awaited<ReturnType<typeof selectViews>>[number]): TaskView => ({
    task: row.task,
    assignee: row.assignee?.id ? row.assignee : null,
    reporter: row.reporter,
    isDependent: Boolean(row.isDependent),
  });

  const listWhere = (programId: string, f: TaskListFilters): SQL =>
    and(
      eq(tasks.programId, programId),
      eq(tasks.isActive, true),
      f.status ? inArray(tasks.status, f.status) : undefined,
      f.priority ? inArray(tasks.priority, f.priority) : undefined,
      f.assigneeId ? eq(tasks.assigneeId, f.assigneeId) : undefined,
      f.unassigned === true ? isNull(tasks.assigneeId) : undefined,
      f.unassigned === false ? sql`${tasks.assigneeId} is not null` : undefined,
      f.reporterId ? eq(tasks.reporterId, f.reporterId) : undefined,
      f.label ? arrayOverlaps(tasks.labels, f.label) : undefined,
      f.dueFrom ? gte(tasks.dueDate, f.dueFrom) : undefined,
      f.dueTo ? lte(tasks.dueDate, f.dueTo) : undefined,
      f.isDependent === true ? isDependentSql : undefined,
      f.isDependent === false ? sql`not ${isDependentSql}` : undefined,
      f.q ? or(ilike(tasks.title, likeContains(f.q)), eq(tasks.key, f.q.toUpperCase())) : undefined,
    )!;

  return {
    ...base,
    withTx: (tx: DbExecutor) => createTaskRepository(tx),

    // Active task in this program by UUID or key (case-insensitive)
    findByRef(programId: string, ref: string): Promise<Task | undefined> {
      const match = isUuid(ref) ? eq(tasks.id, ref) : eq(tasks.key, ref.toUpperCase());
      return base.findOne(and(eq(tasks.programId, programId), match)!);
    },

    async findViewById(id: string): Promise<TaskView | undefined> {
      const [row] = await selectViews().where(and(eq(tasks.id, id), eq(tasks.isActive, true)));
      return row ? toView(row) : undefined;
    },

    async listViews(programId: string, filters: TaskListFilters) {
      const where = listWhere(programId, filters);
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

    // Distinct labels on the program's active tasks with usage counts
    async labelStats(programId: string): Promise<Array<{ label: string; taskCount: number }>> {
      const result = await executor.execute<{ label: string; task_count: string }>(sql`
        SELECT label, count(*) AS task_count
        FROM ${tasks}, unnest(${tasks.labels}) AS label
        WHERE ${tasks.programId} = ${programId} AND ${tasks.isActive} = true
        GROUP BY label
        ORDER BY task_count DESC, label ASC
      `);
      return result.rows.map((r) => ({ label: r.label, taskCount: Number(r.task_count) }));
    },
  };
}

export const taskRepository = createTaskRepository();
