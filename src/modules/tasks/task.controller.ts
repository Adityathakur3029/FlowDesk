import type { Request, Response } from "express";
import * as taskService from "./task.service";
import { toTaskDetailDto, toTaskDto } from "./task.dto";
import {
  addDependencySchema,
  createTaskSchema,
  dependencyParamSchema,
  listTasksQuerySchema,
  parseTaskLocator,
  parseTaskParent,
  taskRefDependencyParamSchema,
  updateTaskSchema,
} from "./task.validation";

// create/list serve /programs/:programId/tasks and /boards/:boardId/tasks; the single-task handlers
// serve /programs/:programId/tasks/:taskRef… and /tasks/:taskRef…. The params say which.

// POST /programs/:programId/tasks, POST /boards/:boardId/tasks
export async function create(req: Request, res: Response): Promise<void> {
  const parent = parseTaskParent(req.params);
  const input = createTaskSchema.parse(req.body);
  const detail = await taskService.createTask(parent, input, req.auth!.employeeId);
  res.status(201).json({ data: toTaskDetailDto(detail) });
}

// GET /programs/:programId/tasks, GET /boards/:boardId/tasks (?status=&assigneeId=&label=&q=&sort=&…)
export async function list(req: Request, res: Response): Promise<void> {
  const parent = parseTaskParent(req.params);
  const query = listTasksQuerySchema.parse(req.query);
  const page = await taskService.listTasks(parent, query, req.auth!);
  res.json({
    data: page.items.map(toTaskDto),
    meta: { total: page.total, limit: page.limit, offset: page.offset },
  });
}

// GET /programs/:programId/tasks/:taskRef, GET /tasks/:taskRef
export async function getByRef(req: Request, res: Response): Promise<void> {
  const detail = await taskService.getTask(parseTaskLocator(req.params));
  res.json({ data: toTaskDetailDto(detail) });
}

// PATCH /programs/:programId/tasks/:taskRef, PATCH /tasks/:taskRef
export async function update(req: Request, res: Response): Promise<void> {
  const locator = parseTaskLocator(req.params);
  const input = updateTaskSchema.parse(req.body);
  const detail = await taskService.updateTask(locator, input);
  res.json({ data: toTaskDetailDto(detail) });
}

// DELETE /programs/:programId/tasks/:taskRef, DELETE /tasks/:taskRef
export async function remove(req: Request, res: Response): Promise<void> {
  await taskService.deleteTask(parseTaskLocator(req.params), req.auth!);
  res.status(204).end();
}

// POST /programs/:programId/tasks/:taskRef/dependencies, POST /tasks/:taskRef/dependencies
export async function addDependency(req: Request, res: Response): Promise<void> {
  const locator = parseTaskLocator(req.params);
  const { dependsOnTaskId } = addDependencySchema.parse(req.body);
  const detail = await taskService.addDependency(locator, dependsOnTaskId);
  res.status(201).json({ data: toTaskDetailDto(detail) });
}

// DELETE /programs/:programId/tasks/:taskRef/dependencies/:dependsOnTaskId, DELETE /tasks/:taskRef/dependencies/:dependsOnTaskId
export async function removeDependency(req: Request, res: Response): Promise<void> {
  const { dependsOnTaskId, ...locator } =
    "programId" in req.params ? dependencyParamSchema.parse(req.params) : taskRefDependencyParamSchema.parse(req.params);
  const detail = await taskService.removeDependency(locator, dependsOnTaskId);
  res.json({ data: toTaskDetailDto(detail) });
}
