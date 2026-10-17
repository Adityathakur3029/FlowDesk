import { and, asc, eq, ne, or, sql } from "drizzle-orm";
import { createRepository } from "../../db/repository";
import { taskDependencies, tasks, type TaskDependency, type TaskStatus } from "../../db/schema";
import { db, type DbExecutor } from "../../db";

export interface TaskSummary {
  id: string;
  key: string;
  title: string;
  status: TaskStatus;
}

const summaryColumns = { id: tasks.id, key: tasks.key, title: tasks.title, status: tasks.status };

// Generic CRUD from createRepository plus graph lookups. Links are hard-deleted,
// so every link points at active tasks (deleting a task removes its links).
export function createTaskDependencyRepository(executor: DbExecutor = db) {
  const base = createRepository(taskDependencies, executor);

  const pair = (taskId: string, dependsOnTaskId: string) =>
    and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnTaskId, dependsOnTaskId))!;

  return {
    ...base,
    withTx: (tx: DbExecutor) => createTaskDependencyRepository(tx),

    findLink(taskId: string, dependsOnTaskId: string): Promise<TaskDependency | undefined> {
      return base.findOne(pair(taskId, dependsOnTaskId));
    },

    countForTask(taskId: string): Promise<number> {
      return base.count(eq(taskDependencies.taskId, taskId));
    },

    // Tasks that block taskId ("is blocked by"), ordered by number
    blockersOf(taskId: string): Promise<TaskSummary[]> {
      return executor
        .select(summaryColumns)
        .from(taskDependencies)
        .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
        .where(eq(taskDependencies.taskId, taskId))
        .orderBy(asc(tasks.number));
    },

    // Blockers that aren't DONE
    openBlockersOf(taskId: string): Promise<TaskSummary[]> {
      return executor
        .select(summaryColumns)
        .from(taskDependencies)
        .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
        .where(and(eq(taskDependencies.taskId, taskId), ne(tasks.status, "DONE")))
        .orderBy(asc(tasks.number));
    },

    // Tasks that taskId blocks ("blocks"), ordered by number
    dependentsOf(taskId: string): Promise<TaskSummary[]> {
      return executor
        .select(summaryColumns)
        .from(taskDependencies)
        .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
        .where(eq(taskDependencies.dependsOnTaskId, taskId))
        .orderBy(asc(tasks.number));
    },

    async deleteLink(taskId: string, dependsOnTaskId: string): Promise<boolean> {
      const rows = await executor
        .delete(taskDependencies)
        .where(pair(taskId, dependsOnTaskId))
        .returning({ id: taskDependencies.id });
      return rows.length > 0;
    },

    // Removes every link on either side of taskId; returns the ids of its former dependents
    async deleteAllForTask(taskId: string): Promise<string[]> {
      const rows = await executor
        .delete(taskDependencies)
        .where(or(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnTaskId, taskId)))
        .returning({ taskId: taskDependencies.taskId, dependsOnTaskId: taskDependencies.dependsOnTaskId });
      return rows.filter((r) => r.dependsOnTaskId === taskId).map((r) => r.taskId);
    },

    // True when taskId is reachable from dependsOnTaskId by following "depends on" links,
    // i.e. adding taskId -> dependsOnTaskId would close a cycle. Drizzle's query builder has
    // no recursive CTE, so this uses the sql template.
    async wouldCreateCycle(taskId: string, dependsOnTaskId: string): Promise<boolean> {
      const result = await executor.execute(sql`
        WITH RECURSIVE reachable(id) AS (
          SELECT depends_on_task_id FROM ${taskDependencies} WHERE task_id = ${dependsOnTaskId}
          UNION
          SELECT d.depends_on_task_id FROM ${taskDependencies} d JOIN reachable r ON d.task_id = r.id
        )
        SELECT 1 FROM reachable WHERE id = ${taskId} LIMIT 1
      `);
      return result.rows.length > 0;
    },
  };
}

export const taskDependencyRepository = createTaskDependencyRepository();
