import { and, asc, count, eq, ilike, inArray, sql, type SQL } from "drizzle-orm";
import { createRepository, type Page } from "../../db/repository";
import { employees, teams, type Team } from "../../db/schema";
import { db, type DbExecutor } from "../../db";
import { likeContains } from "../programs/program.repository";

export type TeamWithCount = Team & { memberCount: number };

// Generic CRUD from createRepository plus name lookup, locking and member counts
export function createTeamRepository(executor: DbExecutor = db) {
  const base = createRepository(teams, executor);

  // Active employees per team, for these team ids
  async function memberCounts(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await executor
      .select({ teamId: employees.teamId, value: count() })
      .from(employees)
      .where(and(inArray(employees.teamId, ids), eq(employees.isActive, true)))
      .groupBy(employees.teamId);
    return new Map(rows.map((r) => [r.teamId!, r.value]));
  }

  async function lock(id: string, strength: "update" | "share"): Promise<Team | undefined> {
    const [row] = await executor
      .select()
      .from(teams)
      .where(and(eq(teams.id, id), eq(teams.isActive, true)))
      .for(strength);
    return row;
  }

  return {
    ...base,
    withTx: (tx: DbExecutor) => createTeamRepository(tx),

    // Case-insensitive, active teams only (matches teams_active_name_unique)
    findByName(name: string): Promise<Team | undefined> {
      return base.findOne(sql`lower(${teams.name}) = lower(${name})`);
    },

    nameSearchWhere(q: string): SQL {
      return ilike(teams.name, likeContains(q));
    },

    async findByIdWithCount(id: string): Promise<TeamWithCount | undefined> {
      const team = await base.findById(id);
      if (!team) return undefined;
      const counts = await memberCounts([team.id]);
      return { ...team, memberCount: counts.get(team.id) ?? 0 };
    },

    // Sorted by name, case-insensitively
    async findPageWithCounts(opts: { where?: SQL; limit: number; offset: number }): Promise<Page<TeamWithCount>> {
      const page = await base.findPage({ ...opts, orderBy: [asc(sql`lower(${teams.name})`), asc(teams.id)] });
      const counts = await memberCounts(page.items.map((t) => t.id));
      return { ...page, items: page.items.map((t) => ({ ...t, memberCount: counts.get(t.id) ?? 0 })) };
    },

    // SELECT … FOR UPDATE on an active team. Taken by team delete; call inside a transaction.
    lockForUpdate(id: string): Promise<Team | undefined> {
      return lock(id, "update");
    },

    // SELECT … FOR SHARE on an active team. Taken by anything that attaches a program or
    // member to the team, so a concurrent delete waits; call inside a transaction.
    lockForShare(id: string): Promise<Team | undefined> {
      return lock(id, "share");
    },
  };
}

export const teamRepository = createTeamRepository();
