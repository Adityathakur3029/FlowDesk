import { index, integer, pgEnum, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";
import { baseColumns } from "./base";
import { teams } from "./teams";

export const programStatus = pgEnum("program_status", ["PLANNED", "ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"]);

// The core entity; tasks (and later reports, insights, docs, findings) belong to a program.
// See .claude/specs/04-program-tasks.md
export const programs = pgTable(
  "programs",
  {
    ...baseColumns(),
    // Short uppercase prefix of task keys (MKT -> MKT-42). Immutable; stays taken after soft delete.
    key: varchar("key", { length: 10 }).notNull().unique("programs_key_unique"),
    name: varchar("name", { length: 150 }).notNull(),
    description: text("description"),
    status: programStatus("status").notNull().default("PLANNED"),
    // Last task number handed out in this program. Internal, never returned.
    taskCounter: integer("task_counter").notNull().default(0),
    // Required by the API; NULL only on programs created before teams existed. See .claude/specs/06-teams.md
    ownerTeamId: uuid("owner_team_id").references(() => teams.id),
  },
  (t) => [index("programs_owner_team_id_idx").on(t.ownerTeamId)],
);

export type Program = typeof programs.$inferSelect;
export type NewProgram = typeof programs.$inferInsert;
export type ProgramStatus = (typeof programStatus.enumValues)[number];
