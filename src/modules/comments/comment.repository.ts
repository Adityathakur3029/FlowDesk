import { and, asc, count, desc, eq, exists, inArray, isNull, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { createRepository } from "../../db/repository";
import { comments, employees, tasks, type Comment } from "../../db/schema";
import { db, type DbExecutor } from "../../db";
import type { EmployeeSummary } from "../tasks/task.repository";
import type { ListCommentsQuery } from "./comment.validation";

// A comment with its author (the DTO hides the author on tombstones)
export interface CommentRow {
  comment: Comment;
  author: EmployeeSummary;
}

// Program comments have no task; task comments have task_id set
export interface CommentTarget {
  programId: string;
  taskId: string | null;
}

const reply = alias(comments, "reply");

// A deleted top-level comment is still listed (as a tombstone) while it has an active reply
const hasActiveReply = (executor: DbExecutor) =>
  exists(
    executor
      .select({ id: reply.id })
      .from(reply)
      .where(and(eq(reply.parentId, comments.id), eq(reply.isActive, true))),
  );

// Generic CRUD from createRepository plus thread and list queries
export function createCommentRepository(executor: DbExecutor = db) {
  const base = createRepository(comments, executor);

  const selectRows = () =>
    executor
      .select({
        comment: comments,
        author: { id: employees.id, name: employees.name, emailId: employees.emailId },
      })
      .from(comments)
      .innerJoin(employees, eq(employees.id, comments.authorId));

  const threadsWhere = ({ programId, taskId }: CommentTarget): SQL =>
    and(
      eq(comments.programId, programId),
      taskId ? eq(comments.taskId, taskId) : isNull(comments.taskId),
      isNull(comments.parentId),
      or(eq(comments.isActive, true), hasActiveReply(executor)),
    )!;

  return {
    ...base,
    withTx: (tx: DbExecutor) => createCommentRepository(tx),

    // Active comment in this program whose task (if any) is active; anything else is "not found".
    // `lock` takes a row lock on the comment (call inside a transaction).
    async findReachable(programId: string, commentId: string, lock?: "update" | "share"): Promise<Comment | undefined> {
      let query = executor
        .select({ comment: comments })
        .from(comments)
        .leftJoin(tasks, eq(tasks.id, comments.taskId))
        .where(
          and(
            eq(comments.id, commentId),
            eq(comments.programId, programId),
            eq(comments.isActive, true),
            or(isNull(comments.taskId), eq(tasks.isActive, true)),
          ),
        )
        .$dynamic();
      if (lock) query = query.for(lock, { of: comments });
      const [row] = await query;
      return row?.comment;
    },

    async findRowById(id: string): Promise<CommentRow | undefined> {
      const [row] = await selectRows().where(eq(comments.id, id));
      return row;
    },

    // A page of top-level comments on the target: active ones plus tombstones with active replies
    async listThreads(target: CommentTarget, query: ListCommentsQuery) {
      const where = threadsWhere(target);
      const dir = query.order === "desc" ? desc : asc;
      const [items, [total]] = await Promise.all([
        selectRows()
          .where(where)
          .orderBy(dir(comments.createdAt), dir(comments.id))
          .limit(query.limit)
          .offset(query.offset),
        executor.select({ value: count() }).from(comments).where(where),
      ]);
      return { items, total: total?.value ?? 0, limit: query.limit, offset: query.offset };
    },

    // Active replies to the given top-level comments, oldest first
    async activeRepliesOf(parentIds: string[]): Promise<CommentRow[]> {
      if (parentIds.length === 0) return [];
      return selectRows()
        .where(and(inArray(comments.parentId, parentIds), eq(comments.isActive, true)))
        .orderBy(asc(comments.createdAt), asc(comments.id));
    },
  };
}

export const commentRepository = createCommentRepository();
