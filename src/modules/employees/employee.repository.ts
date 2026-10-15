import { eq } from "drizzle-orm";
import { createRepository, type ScopeOptions } from "../../db/repository";
import { employees, type Employee } from "../../db/schema";
import type { DbExecutor } from "../../db";

// Generic CRUD from createRepository plus employee-specific lookups
export function createEmployeeRepository(executor?: DbExecutor) {
  const base = createRepository(employees, executor);

  return {
    ...base,
    withTx: (tx: DbExecutor) => createEmployeeRepository(tx),

    findByEmail(emailId: string, opts: ScopeOptions = {}): Promise<Employee | undefined> {
      return base.findOne(eq(employees.emailId, emailId.toLowerCase()), opts);
    },
  };
}

export const employeeRepository = createEmployeeRepository();
