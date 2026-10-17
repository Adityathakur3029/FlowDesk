import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, unique, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { baseColumns } from "./base";
import { employees } from "./employees";
import { programs } from "./programs";
import { tasks } from "./tasks";

// Discussion on a program (task_id NULL) or on one of its tasks, with one level of replies.
// is_active = false means deleted. See .claude/specs/05-comments.md
export const comments = pgTable(
  "comments",
  {
    ...baseColumns(),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id),
    // NULL means a program-level comment. Future targets (reports, …) get their own nullable FK.
    taskId: uuid("task_id").references(() => tasks.id),
    // NULL means a top-level comment; replies only point at top-level comments
    parentId: uuid("parent_id").references((): AnyPgColumn => comments.id),
    authorId: uuid("author_id")
      .notNull()
      .references(() => employees.id),
    // Markdown, stored as sent after trimming. Mentions are `@[Name](mention:<uuid>)` tokens.
    body: text("body").notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
  },
  (t) => [
    // "The program, or exactly one child entity"; widen when more targets arrive
    check("comments_single_target_check", sql`num_nonnulls(${t.taskId}) <= 1`),
    check("comments_no_self_parent_check", sql`${t.parentId} IS NULL OR ${t.parentId} <> ${t.id}`),
    index("comments_program_created_idx").on(t.programId, t.createdAt),
    index("comments_task_created_idx").on(t.taskId, t.createdAt),
    index("comments_parent_id_idx").on(t.parentId),
  ],
);

// Employees mentioned in a comment. Rows are hard-deleted, so is_active stays true.
// created_at is when the person was first mentioned in that comment (edits keep it).
export const commentMentions = pgTable(
  "comment_mentions",
  {
    ...baseColumns(),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id),
    commentId: uuid("comment_id")
      .notNull()
      .references(() => comments.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
  },
  (t) => [
    unique("comment_mentions_pair_unique").on(t.commentId, t.employeeId),
    index("comment_mentions_employee_idx").on(t.employeeId, t.createdAt),
  ],
);

export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;
export type CommentMention = typeof commentMentions.$inferSelect;
