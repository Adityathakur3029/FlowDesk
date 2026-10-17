import { and, eq, isNull } from "drizzle-orm";
import { createRepository, type ScopeOptions } from "../../db/repository";
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
