import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../../config/env";
import { employeeRole, type EmployeeRole } from "../../db/schema";
import { BadRequestError } from "../../lib/errors";

export interface InviteTokenPayload {
  inviteId: string;
  email: string;
  role: EmployeeRole;
}

const payloadSchema = z.object({
  inviteId: z.uuid(),
  email: z.email(),
  role: z.enum(employeeRole.enumValues),
});

// exp matches the invite row's expires_at
export function signInviteToken(payload: InviteTokenPayload, expiresAt: Date): string {
  return jwt.sign({ ...payload, exp: Math.floor(expiresAt.getTime() / 1000) }, env.INVITE_TOKEN_SECRET, {
    algorithm: "HS256",
  });
}

// Checks the signature only. Expiry is checked by the service against expires_at,
// so an expired link gets a specific 410 instead of a generic token error.
export function verifyInviteToken(token: string): InviteTokenPayload {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, env.INVITE_TOKEN_SECRET, { algorithms: ["HS256"], ignoreExpiration: true });
  } catch {
    throw new BadRequestError("Invalid invite token", "INVALID_INVITE_TOKEN");
  }

  const parsed = payloadSchema.safeParse(decoded);
  if (!parsed.success) throw new BadRequestError("Invalid invite token", "INVALID_INVITE_TOKEN");
  return parsed.data;
}
