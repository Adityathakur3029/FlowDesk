import type { DbExecutor } from "../../db";
import { taskRepository } from "./task.repository";
import { taskDependencyRepository } from "./taskDependency.repository";

// The only code that sets or clears DEPENDENT. Run inside the caller's transaction,
// after the program row is locked. See "Dependency and status rules" in spec 04.
export async function syncDependentStatus(tx: DbExecutor, taskId: string): Promise<void> {
  const taskRepo = taskRepository.withTx(tx);
  const task = await taskRepo.findById(taskId);
  // Finished work stays finished, even when a blocker is reopened
  if (!task || task.status === "DONE") return;

  const blocked = (await taskDependencyRepository.withTx(tx).openBlockersOf(taskId)).length > 0;
  if (blocked && task.status !== "DEPENDENT") {
    await taskRepo.updateById(taskId, { status: "DEPENDENT", statusBeforeDependent: task.status });
  } else if (!blocked && task.status === "DEPENDENT") {
    await taskRepo.updateById(taskId, {
      status: task.statusBeforeDependent ?? "DISCUSSION",
      statusBeforeDependent: null,
    });
  }
}

// After a task moves into or out of DONE (or is deleted). One level is enough: syncing
// never changes DONE-ness, so it can't affect whether a dependent blocks anything.
export async function syncDependents(tx: DbExecutor, dependentIds: string[]): Promise<void> {
  for (const id of dependentIds) await syncDependentStatus(tx, id);
}
