import { and, eq } from "drizzle-orm";
import { createRepository } from "../../db/repository";
import { employeeInvites, type EmployeeInvite } from "../../db/schema";
import { db, type DbExecutor } from "../../db";

// Generic CRUD from createRepository plus invite-specific lookups and status changes
export function createInviteRepository(executor: DbExecutor = db) {
  const base = createRepository(employeeInvites, executor);

  const pendingFor = (emailId: string) =>
    and(eq(employeeInvites.emailId, emailId.toLowerCase()), eq(employeeInvites.status, "PENDING"));

  return {
    ...base,
    withTx: (tx: DbExecutor) => createInviteRepository(tx),

    findPendingByEmail(emailId: string): Promise<EmployeeInvite | undefined> {
      return base.findOne(pendingFor(emailId)!);
    },

    // Supersede the live invite (if any) so its link stops working
    async revokePendingForEmail(emailId: string): Promise<void> {
      await executor.update(employeeInvites).set({ status: "REVOKED" }).where(pendingFor(emailId));
    },

    // Conditional update: only one concurrent accept can win
    async markAcceptedIfPending(id: string): Promise<EmployeeInvite | undefined> {
      const [row] = await executor
        .update(employeeInvites)
        .set({ status: "ACCEPTED", acceptedAt: new Date() })
        .where(and(eq(employeeInvites.id, id), eq(employeeInvites.status, "PENDING")))
        .returning();
      return row;
    },

    async markExpired(id: string): Promise<void> {
      await executor
        .update(employeeInvites)
        .set({ status: "EXPIRED" })
        .where(and(eq(employeeInvites.id, id), eq(employeeInvites.status, "PENDING")));
    },
  };
}

export const inviteRepository = createInviteRepository();
