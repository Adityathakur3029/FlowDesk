import { sql } from "drizzle-orm";
import { index, pgEnum, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { baseColumns } from "./base";
import { employeeRole, employees } from "./employees";

export const inviteStatus = pgEnum("invite_status", ["PENDING", "ACCEPTED", "EXPIRED", "REVOKED"]);

// Organisation-level invites (not program-owned). See .claude/specs/02-invite-member.md
export const employeeInvites = pgTable(
  "employee_invites",
  {
    ...baseColumns(),
    // Invitee's organisation email, stored lowercased
    emailId: varchar("email_id", { length: 255 }).notNull(),
    // Invitee's name, chosen by the inviter; used for the employee row on accept
    name: varchar("name", { length: 150 }).notNull(),
    // Role the employee gets on accept; also carried in the signed token
    role: employeeRole("role").notNull(),
    status: inviteStatus("status").notNull().default("PENDING"),
    // Source of truth for expiry: a PENDING invite past this instant is expired
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    employeeId: uuid("employee_id").references(() => employees.id),
  },
  (t) => [
    // At most one live invite per email
    uniqueIndex("employee_invites_pending_email_unique").on(t.emailId).where(sql`${t.status} = 'PENDING'`),
    index("employee_invites_email_id_idx").on(t.emailId),
  ],
);

export type EmployeeInvite = typeof employeeInvites.$inferSelect;
export type NewEmployeeInvite = typeof employeeInvites.$inferInsert;
export type InviteStatus = (typeof inviteStatus.enumValues)[number];
