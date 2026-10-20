import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { baseColumns } from "./base";
import { employees } from "./employees";
import { programs } from "./programs";

export const taskStatus = pgEnum("task_status", ["DISCUSSION", "ON_HOLD", "IN_PROGRESS", "DONE", "DEPENDENT"]);
// Declaration order is the sort order (LOWEST < HIGHEST)
export const taskPriority = pgEnum("task_priority", ["LOWEST", "LOW", "MEDIUM", "HIGH", "HIGHEST"]);
// Informational kind of work; declaration order is the sort order. See .claude/specs/07-task-types.md
export const taskType = pgEnum("task_type", ["PRE", "TASK", "POST", "BUG", "ISSUE"]);

// Jira-style tasks owned by a program. See .claude/specs/04-program-tasks.md
export const tasks = pgTable(
  "tasks",
  {
    ...baseColumns(),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id),
    // Per-program sequence, never reused
    number: integer("number").notNull(),
    // `<program key>-<number>`, stored so lookup by key is one index hit
    key: varchar("key", { length: 24 }).notNull().unique("tasks_key_unique"),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    type: taskType("type").notNull().default("TASK"),
    status: taskStatus("status").notNull().default("DISCUSSION"),
    // Status to restore when the last open blocker is done; set only while status = DEPENDENT
    statusBeforeDependent: taskStatus("status_before_dependent"),
    priority: taskPriority("priority").notNull().default("MEDIUM"),
    assigneeId: uuid("assignee_id").references(() => employees.id),
    reporterId: uuid("reporter_id")
      .notNull()
      .references(() => employees.id),
    startDate: date("start_date", { mode: "string" }),
    dueDate: date("due_date", { mode: "string" }),
    estimateMinutes: integer("estimate_minutes"),
    labels: text("labels").array().notNull().default(sql`'{}'::text[]`),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    unique("tasks_program_number_unique").on(t.programId, t.number),
    check(
      "tasks_date_range_check",
      sql`${t.dueDate} IS NULL OR ${t.startDate} IS NULL OR ${t.dueDate} >= ${t.startDate}`,
    ),
    check("tasks_estimate_positive_check", sql`${t.estimateMinutes} IS NULL OR ${t.estimateMinutes} > 0`),
    check(
      "tasks_dependent_state_check",
      sql`(${t.status} = 'DEPENDENT') = (${t.statusBeforeDependent} IS NOT NULL)`,
    ),
    index("tasks_program_status_idx").on(t.programId, t.status),
    index("tasks_program_type_idx").on(t.programId, t.type),
    index("tasks_assignee_id_idx").on(t.assigneeId),
    index("tasks_due_date_idx").on(t.dueDate),
    // Org-wide date-range counts in the overview report (spec 09)
    index("tasks_created_at_idx").on(t.createdAt),
    index("tasks_completed_at_idx").on(t.completedAt),
    index("tasks_labels_idx").using("gin", t.labels),
  ],
);

// "task_id is blocked by depends_on_task_id". Links are hard-deleted, so is_active stays true.
export const taskDependencies = pgTable(
  "task_dependencies",
  {
    ...baseColumns(),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    dependsOnTaskId: uuid("depends_on_task_id")
      .notNull()
      .references(() => tasks.id),
  },
  (t) => [
    unique("task_dependencies_pair_unique").on(t.taskId, t.dependsOnTaskId),
    check("task_dependencies_no_self_check", sql`${t.taskId} <> ${t.dependsOnTaskId}`),
    index("task_dependencies_depends_on_task_id_idx").on(t.dependsOnTaskId),
  ],
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskStatus = (typeof taskStatus.enumValues)[number];
export type TaskPriority = (typeof taskPriority.enumValues)[number];
export type TaskType = (typeof taskType.enumValues)[number];
export type TaskDependency = typeof taskDependencies.$inferSelect;
