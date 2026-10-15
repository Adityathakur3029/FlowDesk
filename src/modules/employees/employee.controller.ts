import type { Request, Response } from "express";
import * as employeeService from "./employee.service";
import { createEmployeeSchema, employeeIdParamSchema, listEmployeesQuerySchema } from "./employee.validation";

// POST /employees — seeds a single employee
export async function create(req: Request, res: Response): Promise<void> {
  const input = createEmployeeSchema.parse(req.body);
  const employee = await employeeService.createEmployee(input);
  res.status(201).json({ data: employee });
}

// GET /employees?role=&includeInactive=&limit=&offset=
export async function list(req: Request, res: Response): Promise<void> {
  const query = listEmployeesQuerySchema.parse(req.query);
  const page = await employeeService.listEmployees(query);
  res.json({ data: page.items, meta: { total: page.total, limit: page.limit, offset: page.offset } });
}

// GET /employees/:id
export async function getById(req: Request, res: Response): Promise<void> {
  const { id } = employeeIdParamSchema.parse(req.params);
  const employee = await employeeService.getEmployee(id);
  res.json({ data: employee });
}
