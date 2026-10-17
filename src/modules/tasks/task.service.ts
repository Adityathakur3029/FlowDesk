import { db, withTransaction, type DbExecutor } from "../../db";
import type { Task } from "../../db/schema";
import type { AuthContext } from "../../middleware/auth";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../lib/errors";
import { employeeRepository } from "../employees/employee.repository";
import { programRepository } from "../programs/program.repository";
import { getActiveProgram } from "../programs/program.service";
import type { TaskDetail } from "./task.dto";
import { syncDependents, syncDependentStatus } from "./task.dependencyStatus";
import { taskRepository } from "./task.repository";
import { taskDependencyRepository, type TaskSummary } from "./taskDependency.repository";
import {
  MAX_DEPENDENCIES,
  type CreateTaskInput,
  type ListTasksQuery,
  type UpdateTaskInput,
} from "./task.validation";

const programNotFound = () => new NotFoundError("Program not found");
const taskNotFound = () => new NotFoundError("Task not found");

const taskBlocked = (blockers: TaskSummary[]) =>
  new ConflictError("Task is blocked by unfinished dependencies", "TASK_BLOCKED", { blockers });

async function assertAssignee(tx: DbExecutor, assigneeId: string | null | undefined): Promise<void> {
  if (!assigneeId) return;
  // Default scope hides deactivated employees
  const employee = await employeeRepository.withTx(tx).findById(assigneeId);
  if (!employee) throw new BadRequestError("Assignee not found or inactive", "ASSIGNEE_NOT_FOUND");
}

function assertDateRange(startDate: string | null | undefined, dueDate: string | null | undefined): void {
  // YYYY-MM-DD strings compare correctly as text
  if (startDate && dueDate && dueDate < startDate) {
    throw new BadRequestError("dueDate must be on or after startDate", "INVALID_DATE_RANGE");
  }
}

// A blocker must be an active task in the same program
async function getBlocker(tx: DbExecutor, programId: string, blockerId: string): Promise<Task> {
  const blocker = await taskRepository.withTx(tx).findById(blockerId);
  if (!blocker) throw new BadRequestError(`Dependency task ${blockerId} not found`, "DEPENDENCY_TASK_NOT_FOUND");
  if (blocker.programId !== programId) {
    throw new BadRequestError(`Task ${blocker.key} belongs to another program`, "DEPENDENCY_OTHER_PROGRAM");
  }
  return blocker;
}

async function loadDetail(executor: DbExecutor, taskId: string): Promise<TaskDetail> {
  // Sequential: a transaction is one client, which can't run queries in parallel
  const deps = taskDependencyRepository.withTx(executor);
  const view = await taskRepository.withTx(executor).findViewById(taskId);
  if (!view) throw taskNotFound();
  return { view, dependsOn: await deps.blockersOf(taskId), blocks: await deps.dependentsOf(taskId) };
}

// Locks the program row, then finds the task. Every write that can change the
// dependency graph or a task's DONE-ness goes through here (or nextTaskNumber).
async function lockAndFind(tx: DbExecutor, programId: string, taskRef: string): Promise<Task> {
  const program = await programRepository.withTx(tx).lockForUpdate(programId);
  if (!program) throw programNotFound();
  const task = await taskRepository.withTx(tx).findByRef(programId, taskRef);
  if (!task) throw taskNotFound();
  return task;
}

export async function createTask(programId: string, input: CreateTaskInput, reporterId: string): Promise<TaskDetail> {
  return withTransaction(async (tx) => {
    // Takes the number and locks the program row until commit
    const numbered = await programRepository.withTx(tx).nextTaskNumber(programId);
    if (!numbered) throw programNotFound();

    await assertAssignee(tx, input.assigneeId);
    assertDateRange(input.startDate, input.dueDate);

    const blockers: Task[] = [];
    for (const id of input.dependsOn) blockers.push(await getBlocker(tx, programId, id));
    const openBlockers = blockers.filter((b) => b.status !== "DONE");
    if (input.status === "DONE" && openBlockers.length) {
      throw taskBlocked(openBlockers.map(({ id, key, title, status }) => ({ id, key, title, status })));
    }

    const task = await taskRepository.withTx(tx).create({
      programId,
      number: numbered.number,
      key: `${numbered.key}-${numbered.number}`,
      title: input.title,
      description: input.description ?? null,
      status: input.status,
      priority: input.priority,
      assigneeId: input.assigneeId ?? null,
      reporterId,
      startDate: input.startDate ?? null,
      dueDate: input.dueDate ?? null,
      estimateMinutes: input.estimateMinutes ?? null,
      labels: input.labels,
      completedAt: input.status === "DONE" ? new Date() : null,
    });

    await taskDependencyRepository
      .withTx(tx)
      .createMany(blockers.map((b) => ({ programId, taskId: task.id, dependsOnTaskId: b.id })));
    await syncDependentStatus(tx, task.id);
    return loadDetail(tx, task.id);
  });
}

export async function listTasks(programId: string, query: ListTasksQuery, auth: AuthContext) {
  await getActiveProgram(programId);
  const me = (id?: string) => (id === "me" ? auth.employeeId : id);
  return taskRepository.listViews(programId, {
    ...query,
    assigneeId: me(query.assigneeId),
    reporterId: me(query.reporterId),
  });
}

// Unknown or soft-deleted program or task -> 404. Routes nested under a task (e.g. comments) use this too.
export async function getActiveTask(programId: string, taskRef: string): Promise<Task> {
  await getActiveProgram(programId);
  const task = await taskRepository.findByRef(programId, taskRef);
  if (!task) throw taskNotFound();
  return task;
}

export async function getTask(programId: string, taskRef: string): Promise<TaskDetail> {
  const task = await getActiveTask(programId, taskRef);
  return loadDetail(db, task.id);
}

export async function updateTask(programId: string, taskRef: string, input: UpdateTaskInput): Promise<TaskDetail> {
  return withTransaction(async (tx) => {
    const task = await lockAndFind(tx, programId, taskRef);

    if (input.assigneeId !== undefined) await assertAssignee(tx, input.assigneeId);
    // Check the merged values, so changing one date can't break the range
    assertDateRange(
      input.startDate !== undefined ? input.startDate : task.startDate,
      input.dueDate !== undefined ? input.dueDate : task.dueDate,
    );

    const { status, ...fields } = input;
    const patch: Parameters<typeof taskRepository.updateById>[1] = { ...fields };
    let doneChanged = false;

    if (status !== undefined) {
      const deps = taskDependencyRepository.withTx(tx);
      if (task.status === "DEPENDENT") throw taskBlocked(await deps.openBlockersOf(task.id));

      const wasDone = task.status === "DONE";
      const willBeDone = status === "DONE";
      doneChanged = wasDone !== willBeDone;
      patch.status = status;
      if (willBeDone && !wasDone) patch.completedAt = new Date();
      if (wasDone && !willBeDone) {
        patch.completedAt = null;
        // A blocker was reopened after this task finished: reopen straight into DEPENDENT
        if ((await deps.openBlockersOf(task.id)).length) {
          patch.status = "DEPENDENT";
          patch.statusBeforeDependent = status;
        }
      }
    }

    await taskRepository.withTx(tx).updateById(task.id, patch);
    if (doneChanged) {
      const dependents = await taskDependencyRepository.withTx(tx).dependentsOf(task.id);
      await syncDependents(tx, dependents.map((t) => t.id));
    }
    return loadDetail(tx, task.id);
  });
}

export async function deleteTask(programId: string, taskRef: string, auth: AuthContext): Promise<void> {
  await withTransaction(async (tx) => {
    const task = await lockAndFind(tx, programId, taskRef);
    const canDelete = auth.role === "ADMIN" || auth.role === "MANAGER" || task.reporterId === auth.employeeId;
    if (!canDelete) throw new ForbiddenError("You do not have permission to perform this action", "FORBIDDEN");

    await taskRepository.withTx(tx).deactivate(task.id);
    const formerDependents = await taskDependencyRepository.withTx(tx).deleteAllForTask(task.id);
    await syncDependents(tx, formerDependents);
  });
}

export async function addDependency(programId: string, taskRef: string, dependsOnTaskId: string): Promise<TaskDetail> {
  return withTransaction(async (tx) => {
    const task = await lockAndFind(tx, programId, taskRef);
    const deps = taskDependencyRepository.withTx(tx);

    const blocker = await getBlocker(tx, programId, dependsOnTaskId);
    if (blocker.id === task.id) throw new BadRequestError("A task can't depend on itself", "SELF_DEPENDENCY");
    if (await deps.findLink(task.id, blocker.id)) {
      throw new ConflictError(`${task.key} already depends on ${blocker.key}`, "DEPENDENCY_EXISTS");
    }
    if ((await deps.countForTask(task.id)) >= MAX_DEPENDENCIES) {
      throw new BadRequestError(`A task can have at most ${MAX_DEPENDENCIES} dependencies`, "DEPENDENCY_LIMIT_REACHED");
    }
    if (await deps.wouldCreateCycle(task.id, blocker.id)) {
      throw new ConflictError("Adding this dependency would create a cycle", "DEPENDENCY_CYCLE");
    }
    if (task.status === "DONE" && blocker.status !== "DONE") {
      throw new ConflictError("Reopen the task before adding an unfinished dependency", "TASK_DONE");
    }

    await deps.create({ programId, taskId: task.id, dependsOnTaskId: blocker.id });
    await syncDependentStatus(tx, task.id);
    return loadDetail(tx, task.id);
  });
}

export async function removeDependency(programId: string, taskRef: string, dependsOnTaskId: string): Promise<TaskDetail> {
  return withTransaction(async (tx) => {
    const task = await lockAndFind(tx, programId, taskRef);
    const removed = await taskDependencyRepository.withTx(tx).deleteLink(task.id, dependsOnTaskId);
    if (!removed) throw new NotFoundError("Dependency not found");
    await syncDependentStatus(tx, task.id);
    return loadDetail(tx, task.id);
  });
}

export async function listLabels(programId: string) {
  await getActiveProgram(programId);
  return taskRepository.labelStats(programId);
}
