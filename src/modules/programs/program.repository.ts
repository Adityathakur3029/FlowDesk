import { and, asc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { createRepository, type ScopeOptions } from "../../db/repository";
import { programs, type Program } from "../../db/schema";
import { db, type DbExecutor } from "../../db";

// Escapes LIKE wildcards so user input matches literally
function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function likeContains(value: string): string {
  return `%${likeEscape(value)}%`;
}

export function likeStartsWith(value: string): string {
  return `${likeEscape(value)}%`;
}

// Generic CRUD from createRepository plus program-specific lookups and locking
export function createProgramRepository(executor: DbExecutor = db) {
  const base = createRepository(programs, executor);

  return {
    ...base,
    withTx: (tx: DbExecutor) => createProgramRepository(tx),

    findByKey(key: string, opts: ScopeOptions = {}): Promise<Program | undefined> {
      return base.findOne(eq(programs.key, key.toUpperCase()), opts);
    },

    searchWhere(q: string): SQL {
      return or(ilike(programs.name, likeContains(q)), ilike(programs.key, likeContains(q)))!;
    },

    // Active programs owned by a team, by key; used to block a team delete
    findActiveByOwnerTeam(teamId: string, limit: number): Promise<Pick<Program, "id" | "key" | "name">[]> {
      return executor
        .select({ id: programs.id, key: programs.key, name: programs.name })
        .from(programs)
        .where(and(eq(programs.ownerTeamId, teamId), eq(programs.isActive, true)))
        .orderBy(asc(programs.key))
        .limit(limit);
    },

    // Hands out the next task number. The UPDATE also locks the program row until the
    // transaction ends. Returns undefined for an unknown or soft-deleted program.
    async nextTaskNumber(id: string): Promise<{ key: string; number: number } | undefined> {
      const [row] = await executor
        .update(programs)
        .set({ taskCounter: sql`${programs.taskCounter} + 1` })
        .where(and(eq(programs.id, id), eq(programs.isActive, true)))
        .returning({ key: programs.key, number: programs.taskCounter });
      return row;
    },

    // SELECT … FOR UPDATE on an active program. Serialises writes that change a
    // program's dependency graph; call inside a transaction.
    async lockForUpdate(id: string): Promise<Program | undefined> {
      const [row] = await executor
        .select()
        .from(programs)
        .where(and(eq(programs.id, id), eq(programs.isActive, true)))
        .for("update");
      return row;
    },
  };
}

export const programRepository = createProgramRepository();
