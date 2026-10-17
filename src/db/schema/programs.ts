import { integer, pgEnum, pgTable, text, varchar } from "drizzle-orm/pg-core";
import { baseColumns } from "./base";

export const programStatus = pgEnum("program_status", ["PLANNED", "ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"]);

// The core entity; tasks (and later reports, insights, docs, findings) belong to a program.
// See .claude/specs/04-program-tasks.md
export const programs = pgTable("programs", {
  ...baseColumns(),
  // Short uppercase prefix of task keys (MKT -> MKT-42). Immutable; stays taken after soft delete.
  key: varchar("key", { length: 10 }).notNull().unique("programs_key_unique"),
  name: varchar("name", { length: 150 }).notNull(),
  description: text("description"),
  status: programStatus("status").notNull().default("PLANNED"),
  // Last task number handed out in this program. Internal, never returned.
  taskCounter: integer("task_counter").notNull().default(0),
});

export type Program = typeof programs.$inferSelect;
export type NewProgram = typeof programs.$inferInsert;
export type ProgramStatus = (typeof programStatus.enumValues)[number];
