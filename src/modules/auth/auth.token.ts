import jwt, { type SignOptions } from "jsonwebtoken";
import { z } from "zod";
import { env } from "../../config/env";
import { employeeRole, type EmployeeRole } from "../../db/schema";
import { UnauthorizedError } from "../../lib/errors";

export interface AccessTokenPayload {
  employeeId: string;
  email: string;
  role: EmployeeRole;
}

const payloadSchema = z.object({
  sub: z.uuid(),
  email: z.email(),
  role: z.enum(employeeRole.enumValues),
});

// Returns the token and its lifetime in seconds (for the login response)
export function signAccessToken(payload: AccessTokenPayload): { token: string; expiresIn: number } {
  const token = jwt.sign({ email: payload.email, role: payload.role }, env.AUTH_JWT_SECRET, {
    algorithm: "HS256",
    subject: payload.employeeId,
    expiresIn: env.AUTH_JWT_EXPIRES_IN as SignOptions["expiresIn"],
  });
  const { iat, exp } = jwt.decode(token) as { iat: number; exp: number };
  return { token, expiresIn: exp - iat };
}

// Checks signature and expiry. The caller re-checks the employee in the DB.
export function verifyAccessToken(token: string): AccessTokenPayload {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, env.AUTH_JWT_SECRET, { algorithms: ["HS256"] });
  } catch {
    throw new UnauthorizedError("Invalid or expired access token", "INVALID_AUTH_TOKEN");
  }

  const parsed = payloadSchema.safeParse(decoded);
  if (!parsed.success) throw new UnauthorizedError("Invalid or expired access token", "INVALID_AUTH_TOKEN");
  return { employeeId: parsed.data.sub, email: parsed.data.email, role: parsed.data.role };
}
