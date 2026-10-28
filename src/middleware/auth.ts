// Pulls in the req.auth typing for builds that start from the entry file (Vercel), which don't
// pick up src/types/ on their own
/// <reference path="../types/express.d.ts" />
import type { NextFunction, Request, Response } from "express";
import type { EmployeeRole } from "../db/schema";
import { ForbiddenError, UnauthorizedError } from "../lib/errors";
import { verifyAccessToken } from "../modules/auth/auth.token";
import { employeeRepository } from "../modules/employees/employee.repository";

export interface AuthContext {
  employeeId: string;
  email: string;
  role: EmployeeRole;
}

// Requires `Authorization: Bearer <access token>` and sets req.auth.
// The employee is re-read on every request, so deactivation and role changes apply immediately.
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  if (!match) throw new UnauthorizedError("Authentication required", "AUTH_REQUIRED");

  const payload = verifyAccessToken(match[1]);
  // Default scope hides inactive employees
  const employee = await employeeRepository.findById(payload.employeeId);
  if (!employee) throw new UnauthorizedError("Invalid or expired access token", "INVALID_AUTH_TOKEN");

  req.auth = { employeeId: employee.id, email: employee.emailId, role: employee.role };
  next();
}

// Use after requireAuth. Checks the role from the DB (see requireAuth).
export function requireRole(...roles: EmployeeRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) throw new UnauthorizedError("Authentication required", "AUTH_REQUIRED");
    if (!roles.includes(req.auth.role)) {
      throw new ForbiddenError("You do not have permission to perform this action", "FORBIDDEN");
    }
    next();
  };
}
