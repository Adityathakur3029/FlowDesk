import { and, eq, ilike, or, type SQL } from "drizzle-orm";
import { createRepository, type ScopeOptions } from "../../db/repository";
import { boards, type Board } from "../../db/schema";
import { db, type DbExecutor } from "../../db";
import { likeContains } from "../programs/program.repository";

// Generic CRUD from createRepository plus board lookups and locking
export function createBoardRepository(executor: DbExecutor = db) {
  const base = createRepository(boards, executor);

  return {
    ...base,
    withTx: (tx: DbExecutor) => createBoardRepository(tx),

    findByKey(key: string, opts: ScopeOptions = {}): Promise<Board | undefined> {
      return base.findOne(eq(boards.key, key.toUpperCase()), opts);
    },

    searchWhere(q: string): SQL {
      return or(ilike(boards.name, likeContains(q)), ilike(boards.key, likeContains(q)))!;
    },

    // SELECT … FOR UPDATE. Serialises writes that change a board's dependency graph; call inside a
    // transaction. `includeInactive` locks a deleted board too: its tasks stay writable.
    async lockForUpdate(id: string, opts: ScopeOptions = {}): Promise<Board | undefined> {
      const [row] = await executor
        .select()
        .from(boards)
        .where(and(eq(boards.id, id), opts.includeInactive ? undefined : eq(boards.isActive, true)))
        .for("update");
      return row;
    },
  };
}

export const boardRepository = createBoardRepository();
