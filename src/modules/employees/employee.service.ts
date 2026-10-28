import { and, eq, isNull } from "drizzle-orm";
import { withTransaction } from "../../db";
import { employees, type Employee } from "../../db/schema";
import type { Page } from "../../db/repository";
import type { AuthContext } from "../../middleware/auth";
import { ConflictError, getPgErrorCode, NotFoundError, PG_UNIQUE_VIOLATION } from "../../lib/errors";
import { employeeRepository } from "./employee.repository";
import type { CreateEmployeeInput, ListEmployeesQuery, UpdateEmployeeInput } from "./employee.validation";

const employeeExists = (email: string) =>
  new ConflictError(`Employee with email ${email} already exists`, "EMPLOYEE_EXISTS");

export async function createEmployee(input: CreateEmployeeInput): Promise<Employee> {
  // Check inactive rows too: the unique constraint covers them
  const existing = await employeeRepository.findByEmail(input.email, { includeInactive: true });
  if (existing) throw employeeExists(input.email);

  try {
    return await employeeRepository.create({
      emailId: input.email,
      name: input.name,
      role: input.role,
    });
  } catch (err) {
    // Lost a race with a concurrent insert of the same email
    if (getPgErrorCode(err) === PG_UNIQUE_VIOLATION) throw employeeExists(input.email);
    throw err;
  }
}

export async function getEmployee(id: string): Promise<Employee> {
  const employee = await employeeRepository.findById(id);
  if (!employee) throw new NotFoundError("Employee not found");
  return employee;
}

export function listEmployees(query: ListEmployeesQuery): Promise<Page<Employee>> {
  const teamWhere =
    query.teamId === "none" ? isNull(employees.teamId) : query.teamId ? eq(employees.teamId, query.teamId) : undefined;
  return employeeRepository.findPage({
    where: and(
      query.q ? employeeRepository.searchWhere(query.q) : undefined,
      query.role ? eq(employees.role, query.role) : undefined,
      teamWhere,
    ),
    // Without q: the default, newest first
    orderBy: query.q ? employeeRepository.searchOrder(query.q) : undefined,
    includeInactive: query.includeInactive,
    limit: query.limit,
    offset: query.offset,
  });
}

// See .claude/specs/08-employee-search-and-update.md. Rules are applied in the order listed there.
export function updateEmployee(id: string, input: UpdateEmployeeInput, auth: AuthContext): Promise<Employee> {
  return withTransaction(async (tx) => {
    const repo = employeeRepository.withTx(tx);

    // 1. Lock the admins before reading anything, so two admins demoting each other can't both pass step 4
    const removesAdmin = (input.role !== undefined && input.role !== "ADMIN") || input.isActive === false;
    const activeAdminIds = removesAdmin ? await repo.lockActiveAdmins() : [];

    // 2. Inactive employees too, so they can be reactivated
    const employee = await repo.findById(id, { includeInactive: true });
    if (!employee) throw new NotFoundError("Employee not found");

    // 3. The caller is an active ADMIN, so only these two changes would lock them out
    if (id === auth.employeeId) {
      if (input.isActive === false) throw new ConflictError("You can't deactivate your own account", "SELF_LOCKOUT");
      if (removesAdmin) throw new ConflictError("You can't change your own role", "SELF_LOCKOUT");
    }

    // 4. Never leave the organisation without an active ADMIN
    const isActiveAdmin = employee.isActive && employee.role === "ADMIN";
    if (removesAdmin && isActiveAdmin && !activeAdminIds.some((adminId) => adminId !== id)) {
      throw new ConflictError("At least one active ADMIN must remain", "LAST_ADMIN");
    }

    // 5. Only write what differs, so resending the current values changes nothing (not even updatedAt)
    const changes: UpdateEmployeeInput = {};
    if (input.name !== undefined && input.name !== employee.name) changes.name = input.name;
    if (input.role !== undefined && input.role !== employee.role) changes.role = input.role;
    if (input.isActive !== undefined && input.isActive !== employee.isActive) changes.isActive = input.isActive;
    if (Object.keys(changes).length === 0) return employee;

    // 6. Update
    const updated = await repo.updateById(id, changes);
    return updated!;
  });
}
