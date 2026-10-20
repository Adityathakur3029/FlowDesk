import { sql } from "drizzle-orm";
import { check, date, index, integer, pgEnum, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
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
    // Planned schedule, YYYY-MM-DD; both optional
    startDate: date("start_date", { mode: "string" }),
    endDate: date("end_date", { mode: "string" }),
    // When the program last became COMPLETED / CANCELLED; set only while in that status.
    // Their coalesce is the program's finish time. See .claude/specs/09-overview-report.md
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    // Last task number handed out in this program. Internal, never returned.
    taskCounter: integer("task_counter").notNull().default(0),
    // Required by the API; NULL only on programs created before teams existed. See .claude/specs/06-teams.md
    ownerTeamId: uuid("owner_team_id").references(() => teams.id),
  },
  (t) => [
    index("programs_owner_team_id_idx").on(t.ownerTeamId),
    // Backs up the service rule (INVALID_DATE_RANGE)
    check(
      "programs_date_range_check",
      sql`${t.endDate} IS NULL OR ${t.startDate} IS NULL OR ${t.endDate} >= ${t.startDate}`,
    ),
    check("programs_completed_state_check", sql`(${t.status} = 'COMPLETED') = (${t.completedAt} IS NOT NULL)`),
    check("programs_cancelled_state_check", sql`(${t.status} = 'CANCELLED') = (${t.cancelledAt} IS NOT NULL)`),
  ],
);

export type Program = typeof programs.$inferSelect;
export type NewProgram = typeof programs.$inferInsert;
export type ProgramStatus = (typeof programStatus.enumValues)[number];
