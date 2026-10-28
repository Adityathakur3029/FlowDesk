import { pgTable, text, varchar } from "drizzle-orm/pg-core";
import { baseColumns } from "./base";

// Lightweight task containers next to programs: no status, dates or owner team, and they never close.
// is_active = false means deleted; only the board is hidden, its tasks stay live. See .claude/specs/10-boards.md
export const boards = pgTable("boards", {
  ...baseColumns(),
  // Uppercase prefix of the board's task keys (PRO -> PRO-50). Immutable; stays taken after soft delete.
  // May equal a program key: task numbers are global, so the keys still can't collide.
  key: varchar("key", { length: 10 }).notNull().unique("boards_key_unique"),
  name: varchar("name", { length: 150 }).notNull(),
  description: text("description"),
});

export type Board = typeof boards.$inferSelect;
export type NewBoard = typeof boards.$inferInsert;
