import type { Employee } from "../../db/schema";

// Public shape of an employee (matches employeeSchema in employee.docs.ts).
// Internal columns such as google_sub are never returned by the API.
export function toEmployeeDto(employee: Employee) {
  return {
    id: employee.id,
    createdAt: employee.createdAt,
    updatedAt: employee.updatedAt,
    isActive: employee.isActive,
    emailId: employee.emailId,
    name: employee.name,
    role: employee.role,
  };
}

export type EmployeeDto = ReturnType<typeof toEmployeeDto>;
