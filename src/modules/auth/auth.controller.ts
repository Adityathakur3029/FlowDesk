import type { Request, Response } from "express";
import { toEmployeeDto } from "../employees/employee.dto";
import * as authService from "./auth.service";
import { googleLoginSchema } from "./auth.validation";

// POST /auth/google — exchange a Google ID token for a FlowDesk access token
export async function googleLogin(req: Request, res: Response): Promise<void> {
  const input = googleLoginSchema.parse(req.body);
  const result = await authService.loginWithGoogle(input);
  res.json({ data: { ...result, employee: toEmployeeDto(result.employee) } });
}

// GET /auth/me — the employee behind the access token (set by requireAuth)
export async function me(req: Request, res: Response): Promise<void> {
  const employee = await authService.getCurrentEmployee(req.auth!.employeeId);
  res.json({ data: toEmployeeDto(employee) });
}
