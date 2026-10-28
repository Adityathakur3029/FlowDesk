import { env } from "../../config/env";
import type { Employee } from "../../db/schema";
import { ForbiddenError, getPgErrorCode, NotFoundError, PG_UNIQUE_VIOLATION, UnauthorizedError } from "../../lib/errors";
import { employeeRepository } from "../employees/employee.repository";
import { inviteRepository } from "../invites/invite.repository";
import { signAccessToken } from "./auth.token";
import type { GoogleLoginInput } from "./auth.validation";
import { verifyGoogleIdToken } from "./google.verifier";

export interface LoginResult {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  employee: Employee;
}

const accountMismatch = () =>
  new ForbiddenError("This Google account is not the one linked to your FlowDesk account", "GOOGLE_ACCOUNT_MISMATCH");

// See .claude/specs/03-login.md. Rules are applied in the order listed there.
export async function loginWithGoogle(input: GoogleLoginInput): Promise<LoginResult> {
  // 1. Authentication: who are you?
  // TODO: temporary debug logging, remove before merging (it logs the Google identity).
  console.log("Verifying Google ID token...");
  const identity = await verifyGoogleIdToken(input.idToken);
  console.log("Google ID token verified:", identity);
  if (!identity.emailVerified) {
    throw new UnauthorizedError("Your Google email address is not verified", "GOOGLE_EMAIL_NOT_VERIFIED");
  }
  const domain = env.ORG_EMAIL_DOMAIN;
  if (identity.email.split("@")[1] !== domain || (identity.hd !== undefined && identity.hd !== domain)) {
    throw new UnauthorizedError(`Sign in with your @${domain} Google account`, "EMAIL_DOMAIN_NOT_ALLOWED");
  }

  // 2. Authorization: are you allowed?
  let employee = await employeeRepository.findByEmail(identity.email, { includeInactive: true });
  // TODO: temporary, revert. The invite check is disabled, so any employee can log in without
  // an accepted invite. Restore the NOT_INVITED check and the original `!employee.isActive` guard.
  // if (!employee || !(await inviteRepository.hasAcceptedInvite(employee.id))) {
    // throw new ForbiddenError("You have not been invited to FlowDesk", "NOT_INVITED");
  // }
  if (!employee || !employee.isActive) {
    throw new ForbiddenError("Your account has been deactivated", "ACCOUNT_INACTIVE");
  }

  if (employee.googleSub === null) {
    // First login: bind this Google account
    let bound: Employee | undefined;
    try {
      bound = await employeeRepository.setGoogleSubIfUnset(employee.id, identity.sub);
    } catch (err) {
      // This Google account is already linked to another employee
      if (getPgErrorCode(err) === PG_UNIQUE_VIOLATION) throw accountMismatch();
      throw err;
    }
    // A concurrent first login set it first; re-read and compare below
    employee = bound ?? (await employeeRepository.findById(employee.id, { includeInactive: true }))!;
  }
  if (employee.googleSub !== identity.sub) throw accountMismatch();

  // Access granted
  const { token, expiresIn } = signAccessToken({
    employeeId: employee.id,
    email: employee.emailId,
    role: employee.role,
  });
  return { accessToken: token, tokenType: "Bearer", expiresIn, employee };
}

export async function getCurrentEmployee(employeeId: string): Promise<Employee> {
  const employee = await employeeRepository.findById(employeeId);
  if (!employee) throw new NotFoundError("Employee not found");
  return employee;
}
