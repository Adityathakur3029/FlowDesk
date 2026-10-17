import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { createRepository } from "../../db/repository";
import { commentMentions, employees } from "../../db/schema";
import { db, type DbExecutor } from "../../db";
import type { EmployeeSummary } from "../tasks/task.repository";

// Generic CRUD from createRepository plus mention lookups and syncing.
// Rows are hard-deleted, so is_active is always true.
export function createCommentMentionRepository(executor: DbExecutor = db) {
  const base = createRepository(commentMentions, executor);

  return {
    ...base,
    withTx: (tx: DbExecutor) => createCommentMentionRepository(tx),

    // Mentioned employees per comment (deactivated ones included), ordered by name
    async mentionsFor(commentIds: string[]): Promise<Array<{ commentId: string; employee: EmployeeSummary }>> {
      if (commentIds.length === 0) return [];
      return executor
        .select({
          commentId: commentMentions.commentId,
          employee: { id: employees.id, name: employees.name, emailId: employees.emailId },
        })
        .from(commentMentions)
        .innerJoin(employees, eq(employees.id, commentMentions.employeeId))
        .where(inArray(commentMentions.commentId, commentIds))
        .orderBy(asc(employees.name), asc(employees.id));
    },

    async employeeIdsFor(commentId: string): Promise<string[]> {
      const rows = await executor
        .select({ employeeId: commentMentions.employeeId })
        .from(commentMentions)
        .where(eq(commentMentions.commentId, commentId));
      return rows.map((r) => r.employeeId);
    },

    // Makes the comment's rows match employeeIds: deletes rows for people no longer mentioned
    // and inserts rows for new ones. Rows for people still mentioned keep their created_at.
    async replaceForComment(programId: string, commentId: string, employeeIds: string[]): Promise<void> {
      await executor
        .delete(commentMentions)
        .where(
          and(
            eq(commentMentions.commentId, commentId),
            employeeIds.length ? notInArray(commentMentions.employeeId, employeeIds) : undefined,
          ),
        );
      if (employeeIds.length === 0) return;
      await executor
        .insert(commentMentions)
        .values(employeeIds.map((employeeId) => ({ programId, commentId, employeeId })))
        .onConflictDoNothing({ target: [commentMentions.commentId, commentMentions.employeeId] });
    },

    async deleteForComment(commentId: string): Promise<void> {
      await executor.delete(commentMentions).where(eq(commentMentions.commentId, commentId));
    },
  };
}

export const commentMentionRepository = createCommentMentionRepository();
