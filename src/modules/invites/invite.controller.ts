import type { Request, Response } from "express";
import type { EmployeeInvite } from "../../db/schema";
import { toEmployeeDto } from "../employees/employee.dto";
import * as inviteService from "./invite.service";
import { acceptInviteSchema, createInviteSchema } from "./invite.validation";

// Public shape of an invite; the token is only ever sent by email
function toInviteDto(invite: EmployeeInvite) {
  return {
    id: invite.id,
    emailId: invite.emailId,
    name: invite.name,
    role: invite.role,
    status: invite.status,
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt,
  };
}

// POST /invites — invite a new member by email
export async function create(req: Request, res: Response): Promise<void> {
  const input = createInviteSchema.parse(req.body);
  const invite = await inviteService.createInvite(input);
  res.status(201).json({ data: toInviteDto(invite) });
}

// POST /invites/accept — accept an invite and create the employee
export async function accept(req: Request, res: Response): Promise<void> {
  const input = acceptInviteSchema.parse(req.body);
  const employee = await inviteService.acceptInvite(input);
  res.status(201).json({ message: "Successfully added", data: toEmployeeDto(employee) });
}
