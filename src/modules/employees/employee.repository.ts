import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { createRepository, type Page, type ScopeOptions } from "../../db/repository";
import { employees, type Employee } from "../../db/schema";
import { db, type DbExecutor } from "../../db";

// Generic CRUD from createRepository plus employee-specific lookups
export function createEmployeeRepository(executor: DbExecutor = db) {
  const base = createRepository(employees, executor);

  return {
    ...base,
    withTx: (tx: DbExecutor) => createEmployeeRepository(tx),

    findByEmail(emailId: string, opts: ScopeOptions = {}): Promise<Employee | undefined> {
      return base.findOne(eq(employees.emailId, emailId.toLowerCase()), opts);
    },

    // Which of these ids (all UUIDs) belong to active employees
    async findActiveIds(ids: string[]): Promise<Set<string>> {
      if (ids.length === 0) return new Set();
      const rows = await executor
        .select({ id: employees.id })
        .from(employees)
        .where(and(inArray(employees.id, ids), eq(employees.isActive, true)));
      return new Set(rows.map((r) => r.id));
    },

    // Active members of a team, by name
    findTeamMembersPage(teamId: string, opts: { limit: number; offset: number }): Promise<Page<Employee>> {
      return base.findPage({ ...opts, where: eq(employees.teamId, teamId), orderBy: [asc(employees.name), asc(employees.id)] });
    },

    // Moves the employee into the team (out of any other one)
    setTeam(id: string, teamId: string | null): Promise<Employee | undefined> {
      return base.updateById(id, { teamId });
    },

    // Releases every member of a team, inactive employees included
    async clearTeam(teamId: string): Promise<void> {
      await executor.update(employees).set({ teamId: null }).where(eq(employees.teamId, teamId));
    },

    // Binds the Google account on first login. Conditional, so a concurrent first
    // login can't overwrite it; returns undefined when the sub was already set.
    async setGoogleSubIfUnset(id: string, googleSub: string): Promise<Employee | undefined> {
      const [row] = await executor
        .update(employees)
        .set({ googleSub })
        .where(and(eq(employees.id, id), isNull(employees.googleSub)))
        .returning();
      return row;
    },
  };
}

export const employeeRepository = createEmployeeRepository();
