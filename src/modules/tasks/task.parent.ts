import { eq, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

// Every task has exactly one parent, a program or a board, fixed at creation. Rows that hang off a
// task (dependency links, comments, mentions) copy it. See .claude/specs/10-boards.md
export type TaskParent = { programId: string; boardId: null } | { programId: null; boardId: string };

export const programParent = (programId: string): TaskParent => ({ programId, boardId: null });
export const boardParent = (boardId: string): TaskParent => ({ programId: null, boardId });

// The parent columns of a task, comment or anything else that carries them
export function parentOf(row: { programId: string | null; boardId: string | null }): TaskParent {
  return row.programId !== null ? programParent(row.programId) : boardParent(row.boardId!);
}

export function sameParent(a: TaskParent, b: TaskParent): boolean {
  return a.programId === b.programId && a.boardId === b.boardId;
}

// `program_id = …` or `board_id = …` on a table with both parent columns
export function parentWhere(table: { programId: PgColumn; boardId: PgColumn }, parent: TaskParent): SQL {
  return parent.programId !== null ? eq(table.programId, parent.programId) : eq(table.boardId, parent.boardId);
}
