import { sql } from "drizzle-orm";
import { pgTable, text, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { baseColumns } from "./base";

// Organisation-level groups of employees (not program-owned). is_active = false means deleted.
// See .claude/specs/06-teams.md
export const teams = pgTable(
  "teams",
  {
    ...baseColumns(),
    // Stored trimmed, case as sent
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),
  },
  (t) => [
    // Case-insensitive among active teams, so a deleted team's name can be reused
    uniqueIndex("teams_active_name_unique").on(sql`lower(${t.name})`).where(sql`${t.isActive}`),
  ],
);

export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
