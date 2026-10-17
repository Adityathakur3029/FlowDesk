import { z } from "zod";
import { env } from "../config/env";
import { pool, withTransaction } from "../db";
import { createEmployeeRepository } from "../modules/employees/employee.repository";
import { createInviteRepository } from "../modules/invites/invite.repository";

// Creates the first ADMIN so a protected system can be entered at all.
// Login requires an accepted invite, so one is recorded alongside the employee.
// Idempotent: re-running for an admin who already has an accepted invite does nothing.
// Usage: BOOTSTRAP_ADMIN_EMAIL=admin@saajha.org BOOTSTRAP_ADMIN_NAME="Admin" npm run auth:bootstrap-admin

const inputSchema = z.object({
  BOOTSTRAP_ADMIN_EMAIL: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email().max(255))
    .refine((email) => email.split("@")[1] === env.ORG_EMAIL_DOMAIN, {
      message: `must be an @${env.ORG_EMAIL_DOMAIN} address`,
    }),
  BOOTSTRAP_ADMIN_NAME: z.string().trim().min(1).max(150).default("Admin"),
});

async function main(): Promise<void> {
  const parsed = inputSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid bootstrap input:\n${issues}`);
  }
  const { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_NAME: name } = parsed.data;

  const message = await withTransaction(async (tx) => {
    const employees = createEmployeeRepository(tx);
    const invites = createInviteRepository(tx);

    let employee = await employees.findByEmail(email, { includeInactive: true });
    if (!employee) {
      employee = await employees.create({ emailId: email, name, role: "ADMIN" });
    } else if (employee.role !== "ADMIN") {
      employee = (await employees.updateById(employee.id, { role: "ADMIN" }))!;
    }

    if (await invites.hasAcceptedInvite(employee.id)) {
      return `${email} is already bootstrapped (role ${employee.role}); nothing to do`;
    }

    const now = new Date();
    await invites.create({
      emailId: email,
      name: employee.name,
      role: "ADMIN",
      status: "ACCEPTED",
      acceptedAt: now,
      expiresAt: now,
      employeeId: employee.id,
    });
    return `Bootstrapped ${email} as ADMIN. They can now sign in with Google.`;
  });
  console.log(message);
}

main()
  .catch((err) => {
    console.error("Bootstrap failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
