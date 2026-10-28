import { db, withTransaction, type DbExecutor } from "../../db";
import type { Task } from "../../db/schema";
import type { AuthContext } from "../../middleware/auth";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../lib/errors";
import { boardRepository } from "../boards/board.repository";
import { getActiveBoard } from "../boards/board.service";
import { employeeRepository } from "../employees/employee.repository";
import { programRepository } from "../programs/program.repository";
import { getActiveProgram } from "../programs/program.service";
import type { TaskDetail } from "./task.dto";
import { syncDependents, syncDependentStatus } from "./task.dependencyStatus";
import { parentOf, programParent, sameParent, type TaskParent } from "./task.parent";
import { taskRepository } from "./task.repository";
import { taskDependencyRepository, type TaskSummary } from "./taskDependency.repository";
import {
  MAX_DEPENDENCIES,
  type CreateTaskInput,
  type ListTasksQuery,
  type TaskLocator,
  type UpdateTaskInput,
} from "./task.validation";

const parentNotFound = (parent: TaskParent) =>
  new NotFoundError(parent.programId !== null ? "Program not found" : "Board not found");
const taskNotFound = () => new NotFoundError("Task not found");

const taskBlocked = (blockers: TaskSummary[]) =>
  new ConflictError("Task is blocked by unfinished dependencies", "TASK_BLOCKED", { blockers });

// Unknown or soft-deleted program or board -> 404, for the routes that name the parent
async function assertActiveParent(parent: TaskParent): Promise<void> {
  if (parent.programId !== null) await getActiveProgram(parent.programId);
  else await getActiveBoard(parent.boardId);
}

// SELECT … FOR UPDATE on the parent row; returns undefined when it can't be locked. Every write that
// can change the dependency graph or a task's DONE-ness takes this first. A program must be active.
// A deleted board is still locked, since its tasks stay writable, except when creating a task in it.
function lockParent(tx: DbExecutor, parent: TaskParent, forCreate = false): Promise<{ key: string } | undefined> {
  if (parent.programId !== null) return programRepository.withTx(tx).lockForUpdate(parent.programId);
  return boardRepository.withTx(tx).lockForUpdate(parent.boardId, { includeInactive: !forCreate });
}

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

// A blocker must be an active task with the same parent (program or board)
async function getBlocker(tx: DbExecutor, parent: TaskParent, blockerId: string): Promise<Task> {
  const blocker = await taskRepository.withTx(tx).findById(blockerId);
  if (!blocker) throw new BadRequestError(`Dependency task ${blockerId} not found`, "DEPENDENCY_TASK_NOT_FOUND");
  if (!sameParent(parentOf(blocker), parent)) {
    throw new BadRequestError(`Task ${blocker.key} belongs to another program or board`, "DEPENDENCY_OTHER_PARENT");
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

// Locks the task's parent row, then finds the task. Every write that can change the dependency
// graph or a task's DONE-ness goes through here (or createTask).
async function lockAndFind(tx: DbExecutor, locator: TaskLocator): Promise<Task> {
  const taskRepo = taskRepository.withTx(tx);
  if ("programId" in locator) {
    const parent = programParent(locator.programId);
    if (!(await lockParent(tx, parent))) throw parentNotFound(parent);
    const task = await taskRepo.findByRef(parent, locator.taskRef);
    if (!task) throw taskNotFound();
    return task;
  }
  // By ref alone the parent is only known from the task, so find it, lock, then read it again
  const found = await taskRepo.findReachableByRef(locator.taskRef);
  if (!found || !(await lockParent(tx, parentOf(found)))) throw taskNotFound();
  const task = await taskRepo.findById(found.id);
  if (!task) throw taskNotFound();
  return task;
}

export async function createTask(parent: TaskParent, input: CreateTaskInput, reporterId: string): Promise<TaskDetail> {
  return withTransaction(async (tx) => {
    // Locks the parent row until commit
    const locked = await lockParent(tx, parent, true);
    if (!locked) throw parentNotFound(parent);

    await assertAssignee(tx, input.assigneeId);
    assertDateRange(input.startDate, input.dueDate);

    const blockers: Task[] = [];
    for (const id of input.dependsOn) blockers.push(await getBlocker(tx, parent, id));
    const openBlockers = blockers.filter((b) => b.status !== "DONE");
    if (input.status === "DONE" && openBlockers.length) {
      throw taskBlocked(openBlockers.map(({ id, key, title, status }) => ({ id, key, title, status })));
    }

    // Taken after the checks, so a rejected request doesn't use up a number
    const number = await taskRepository.withTx(tx).nextNumber();
    const task = await taskRepository.withTx(tx).create({
      ...parent,
      number,
      key: `${locked.key}-${number}`,
      title: input.title,
      description: input.description ?? null,
      type: input.type,
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
      .createMany(blockers.map((b) => ({ ...parent, taskId: task.id, dependsOnTaskId: b.id })));
    await syncDependentStatus(tx, task.id);
    return loadDetail(tx, task.id);
  });
}

export async function listTasks(parent: TaskParent, query: ListTasksQuery, auth: AuthContext) {
  await assertActiveParent(parent);
  const me = (id?: string) => (id === "me" ? auth.employeeId : id);
  return taskRepository.listViews(parent, {
    ...query,
    assigneeId: me(query.assigneeId),
    reporterId: me(query.reporterId),
  });
}

// The task a single-task route works on; routes nested under a task (e.g. comments) use this too.
// Nested under a program: unknown or soft-deleted program or task -> 404. By ref alone: 404 unless
// the task is reachable (see "Reachable task" in .claude/specs/10-boards.md).
export async function getActiveTask(locator: TaskLocator): Promise<Task> {
  if ("programId" in locator) {
    await getActiveProgram(locator.programId);
    const task = await taskRepository.findByRef(programParent(locator.programId), locator.taskRef);
    if (!task) throw taskNotFound();
    return task;
  }
  const task = await taskRepository.findReachableByRef(locator.taskRef);
  if (!task) throw taskNotFound();
  return task;
}

export async function getTask(locator: TaskLocator): Promise<TaskDetail> {
  const task = await getActiveTask(locator);
  return loadDetail(db, task.id);
}

export async function updateTask(locator: TaskLocator, input: UpdateTaskInput): Promise<TaskDetail> {
  return withTransaction(async (tx) => {
    const task = await lockAndFind(tx, locator);

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

export async function deleteTask(locator: TaskLocator, auth: AuthContext): Promise<void> {
  await withTransaction(async (tx) => {
    const task = await lockAndFind(tx, locator);
    const canDelete = auth.role === "ADMIN" || auth.role === "MANAGER" || task.reporterId === auth.employeeId;
    if (!canDelete) throw new ForbiddenError("You do not have permission to perform this action", "FORBIDDEN");

    await taskRepository.withTx(tx).deactivate(task.id);
    const formerDependents = await taskDependencyRepository.withTx(tx).deleteAllForTask(task.id);
    await syncDependents(tx, formerDependents);
  });
}

export async function addDependency(locator: TaskLocator, dependsOnTaskId: string): Promise<TaskDetail> {
  return withTransaction(async (tx) => {
    const task = await lockAndFind(tx, locator);
    const parent = parentOf(task);
    const deps = taskDependencyRepository.withTx(tx);

    const blocker = await getBlocker(tx, parent, dependsOnTaskId);
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

    await deps.create({ ...parent, taskId: task.id, dependsOnTaskId: blocker.id });
    await syncDependentStatus(tx, task.id);
    return loadDetail(tx, task.id);
  });
}

export async function removeDependency(locator: TaskLocator, dependsOnTaskId: string): Promise<TaskDetail> {
  return withTransaction(async (tx) => {
    const task = await lockAndFind(tx, locator);
    const removed = await taskDependencyRepository.withTx(tx).deleteLink(task.id, dependsOnTaskId);
    if (!removed) throw new NotFoundError("Dependency not found");
    await syncDependentStatus(tx, task.id);
    return loadDetail(tx, task.id);
  });
}

export async function listLabels(parent: TaskParent) {
  await assertActiveParent(parent);
  return taskRepository.labelStats(parent);
}
