import { and, count, desc, eq, type SQL } from "drizzle-orm";
import type { PgColumn, PgInsertValue, PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";
import { db, type DbExecutor } from "./index";

// Any table built with baseColumns()
export type BaseTable = PgTable & {
  id: PgColumn;
  createdAt: PgColumn;
  updatedAt: PgColumn;
  isActive: PgColumn;
};

export interface ScopeOptions {
  // Soft-deleted rows (is_active = false) are hidden unless this is true
  includeInactive?: boolean;
}

export interface FindManyOptions extends ScopeOptions {
  where?: SQL;
  orderBy?: SQL | PgColumn | Array<SQL | PgColumn>;
  limit?: number;
  offset?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// Generic CRUD helpers for a base table. Services use these (or a table-specific
// repository built on top of them) instead of writing queries inline.
// Pass a transaction as `executor` (or call .withTx(tx)) to run inside it.
export function createRepository<T extends BaseTable>(table: T, executor: DbExecutor = db) {
  type Row = T["$inferSelect"];
  type NewRow = T["$inferInsert"];
  type RowUpdate = Partial<Omit<NewRow, "id" | "createdAt" | "updatedAt">>;

  const scoped = (where: SQL | undefined, opts: ScopeOptions = {}) =>
    opts.includeInactive ? where : and(eq(table.isActive, true), where);

  const repo = {
    table,

    withTx(tx: DbExecutor) {
      return createRepository(table, tx);
    },

    async findById(id: string, opts: ScopeOptions = {}): Promise<Row | undefined> {
      return repo.findOne(eq(table.id, id), opts);
    },

    async findOne(where: SQL, opts: ScopeOptions = {}): Promise<Row | undefined> {
      const rows = await executor
        .select()
        .from(table as PgTable)
        .where(scoped(where, opts))
        .limit(1);
      return rows[0] as Row | undefined;
    },

    async findMany(opts: FindManyOptions = {}): Promise<Row[]> {
      const orderBy = opts.orderBy ?? desc(table.createdAt);
      let query = executor
        .select()
        .from(table as PgTable)
        .where(scoped(opts.where, opts))
        .orderBy(...(Array.isArray(orderBy) ? orderBy : [orderBy]))
        .$dynamic();
      if (opts.limit !== undefined) query = query.limit(opts.limit);
      if (opts.offset !== undefined) query = query.offset(opts.offset);
      return (await query) as Row[];
    },

    // findMany + total count for list endpoints
    async findPage(opts: FindManyOptions = {}): Promise<Page<Row>> {
      const limit = Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
      const offset = opts.offset ?? 0;
      const [items, total] = await Promise.all([
        repo.findMany({ ...opts, limit, offset }),
        repo.count(opts.where, opts),
      ]);
      return { items, total, limit, offset };
    },

    async count(where?: SQL, opts: ScopeOptions = {}): Promise<number> {
      const [row] = await executor
        .select({ value: count() })
        .from(table as PgTable)
        .where(scoped(where, opts));
      return row?.value ?? 0;
    },

    async exists(where: SQL, opts: ScopeOptions = {}): Promise<boolean> {
      const rows = await executor
        .select({ id: table.id })
        .from(table as PgTable)
        .where(scoped(where, opts))
        .limit(1);
      return rows.length > 0;
    },

    async create(data: NewRow): Promise<Row> {
      const [row] = await executor
        .insert(table)
        .values(data as PgInsertValue<T>)
        .returning();
      return row as Row;
    },

    async createMany(data: NewRow[]): Promise<Row[]> {
      if (data.length === 0) return [];
      const rows = await executor
        .insert(table)
        .values(data as PgInsertValue<T>[])
        .returning();
      return rows as Row[];
    },

    // Returns undefined when no row matched
    async updateById(id: string, data: RowUpdate): Promise<Row | undefined> {
      const rows = (await executor
        .update(table)
        .set(data as PgUpdateSetSource<T>)
        .where(eq(table.id, id))
        .returning()) as Row[];
      return rows[0];
    },

    // Soft delete
    deactivate(id: string): Promise<Row | undefined> {
      return repo.updateById(id, { isActive: false } as RowUpdate);
    },

    activate(id: string): Promise<Row | undefined> {
      return repo.updateById(id, { isActive: true } as RowUpdate);
    },

    // Permanent delete; prefer deactivate() for domain data
    async hardDeleteById(id: string): Promise<boolean> {
      const rows = await executor
        .delete(table)
        .where(eq(table.id, id))
        .returning({ id: table.id });
      return rows.length > 0;
    },
  };

  return repo;
}
