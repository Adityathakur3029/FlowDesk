import { withTransaction } from "../../db";
import type { Employee, EmployeeInvite } from "../../db/schema";
import { env } from "../../config/env";
import { sendEmail } from "../../lib/email/email.service";
import {
  BadGatewayError,
  BadRequestError,
  ConflictError,
  getPgErrorCode,
  GoneError,
  PG_UNIQUE_VIOLATION,
} from "../../lib/errors";
import { employeeRepository } from "../employees/employee.repository";
import { inviteRepository } from "./invite.repository";
import { signInviteToken, verifyInviteToken } from "./invite.token";
import type { AcceptInviteInput, CreateInviteInput } from "./invite.validation";

const HOUR_MS = 60 * 60 * 1000;

const employeeExists = (email: string) =>
  new ConflictError(`Employee with email ${email} already exists`, "EMPLOYEE_EXISTS");

// POST /invites: record the invite and email the accept link.
// The email domain is already checked by createInviteSchema.
export async function createInvite(input: CreateInviteInput): Promise<EmployeeInvite> {
  console.log("hgegrgfejhfrjehrfeholooooo");
  // Deactivated employees count too: the employees email constraint covers them
  const existing = await employeeRepository.findByEmail(input.email, { includeInactive: true });
  if (existing) throw employeeExists(input.email);

  let invite: EmployeeInvite;
  try {
    // Re-inviting replaces the live invite, so the old link stops working
    invite = await withTransaction(async (tx) => {
      const invites = inviteRepository.withTx(tx);
      await invites.revokePendingForEmail(input.email);
      return invites.create({
        emailId: input.email,
        name: input.name,
        role: input.role,
        expiresAt: new Date(Date.now() + env.INVITE_EXPIRY_HOURS * HOUR_MS),
      });
    });
  } catch (err) {
    // Lost a race with a concurrent invite for the same email (partial unique index)
    if (getPgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ConflictError(`An invite for ${input.email} is already being created`, "INVITE_PENDING");
    }
    throw err;
  }

  const token = signInviteToken({ inviteId: invite.id, email: invite.emailId, role: invite.role }, invite.expiresAt);
  const acceptUrl = `${env.APP_BASE_URL}/invites/accept?token=${encodeURIComponent(token)}`;
  console.log(`Invite accept URL: ${acceptUrl}`);
  try {
    await sendEmail({
      to: invite.emailId,
      template: "inviteMember",
      data: {
        inviteeName: invite.name,
        inviteeEmail: invite.emailId,
        role: invite.role,
        acceptUrl,
        expiresAt: invite.expiresAt,
      },
    });
  } catch (err) {
    // Don't leave a live invite nobody received
    console.error("Failed to send invite email:", err);
    await inviteRepository.updateById(invite.id, { status: "REVOKED" });
    throw new BadGatewayError("Could not send invite email", "EMAIL_DELIVERY_FAILED");
  }

  return invite;
}

// POST /invites/accept: create the employee if the invite is still valid.
// Email and role come from the signed token payload; the name from the invite.
export async function acceptInvite(input: AcceptInviteInput): Promise<Employee> {
  const payload = verifyInviteToken(input.token);

  const invite = await inviteRepository.findById(payload.inviteId);
  if (!invite || invite.emailId !== payload.email || invite.role !== payload.role) {
    throw new BadRequestError("Invalid invite token", "INVALID_INVITE_TOKEN");
  }

  if (invite.status === "REVOKED") {
    throw new BadRequestError("This invite was replaced by a newer one", "INVITE_REVOKED");
  }
  if (invite.status === "ACCEPTED") {
    throw new ConflictError("This invite has already been accepted", "INVITE_ALREADY_ACCEPTED");
  }
  if (invite.status === "EXPIRED" || Date.now() > invite.expiresAt.getTime()) {
    // Outside any transaction so the status change isn't rolled back by the throw
    await inviteRepository.markExpired(invite.id);
    throw new GoneError("Invite link has expired. Ask for a new invite.", "INVITE_EXPIRED");
  }

  try {
    return await withTransaction(async (tx) => {
      const invites = inviteRepository.withTx(tx);
      const accepted = await invites.markAcceptedIfPending(invite.id);
      if (!accepted) {
        // A concurrent request accepted it first
        throw new ConflictError("This invite has already been accepted", "INVITE_ALREADY_ACCEPTED");
      }

      const employee = await employeeRepository.withTx(tx).create({
        emailId: payload.email,
        name: invite.name,
        role: payload.role,
      });
      await invites.updateById(invite.id, { employeeId: employee.id });
      return employee;
    });
  } catch (err) {
    // Employee created some other way (e.g. POST /employees) after the invite was sent
    if (getPgErrorCode(err) === PG_UNIQUE_VIOLATION) throw employeeExists(payload.email);
    throw err;
  }
}
