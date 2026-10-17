import { and, eq, isNull } from "drizzle-orm";
import { employees, type Employee } from "../../db/schema";
import type { Page } from "../../db/repository";
import { ConflictError, getPgErrorCode, NotFoundError, PG_UNIQUE_VIOLATION } from "../../lib/errors";
import { employeeRepository } from "./employee.repository";
import type { CreateEmployeeInput, ListEmployeesQuery } from "./employee.validation";

export async function createEmployee(input: CreateEmployeeInput): Promise<Employee> {
  // Check inactive rows too: the unique constraint covers them
  const existing = await employeeRepository.findByEmail(input.email, { includeInactive: true });
  if (existing) throw new ConflictError(`Employee with email ${input.email} already exists`);

  try {
    return await employeeRepository.create({
      emailId: input.email,
      name: input.name,
      role: input.role,
    });
  } catch (err) {
    // Lost a race with a concurrent insert of the same email
    if (getPgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ConflictError(`Employee with email ${input.email} already exists`);
    }
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
    where: and(query.role ? eq(employees.role, query.role) : undefined, teamWhere),
    includeInactive: query.includeInactive,
    limit: query.limit,
    offset: query.offset,
  });
}
