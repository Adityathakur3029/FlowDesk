import type { Request, Response } from "express";
import * as taskService from "./task.service";
import { toTaskDetailDto, toTaskDto } from "./task.dto";
import { programIdParamSchema } from "../programs/program.validation";
import {
  addDependencySchema,
  createTaskSchema,
  dependencyParamSchema,
  listTasksQuerySchema,
  taskRefParamSchema,
  updateTaskSchema,
} from "./task.validation";

// POST /programs/:programId/tasks
export async function create(req: Request, res: Response): Promise<void> {
  const { programId } = programIdParamSchema.parse(req.params);
  const input = createTaskSchema.parse(req.body);
  const detail = await taskService.createTask(programId, input, req.auth!.employeeId);
  res.status(201).json({ data: toTaskDetailDto(detail) });
}

// GET /programs/:programId/tasks?status=&assigneeId=&label=&q=&sort=&…
export async function list(req: Request, res: Response): Promise<void> {
  const { programId } = programIdParamSchema.parse(req.params);
  const query = listTasksQuerySchema.parse(req.query);
  const page = await taskService.listTasks(programId, query, req.auth!);
  res.json({
    data: page.items.map(toTaskDto),
    meta: { total: page.total, limit: page.limit, offset: page.offset },
  });
}

// GET /programs/:programId/tasks/:taskRef
export async function getByRef(req: Request, res: Response): Promise<void> {
  const { programId, taskRef } = taskRefParamSchema.parse(req.params);
  const detail = await taskService.getTask(programId, taskRef);
  res.json({ data: toTaskDetailDto(detail) });
}

// PATCH /programs/:programId/tasks/:taskRef
export async function update(req: Request, res: Response): Promise<void> {
  const { programId, taskRef } = taskRefParamSchema.parse(req.params);
  const input = updateTaskSchema.parse(req.body);
  const detail = await taskService.updateTask(programId, taskRef, input);
  res.json({ data: toTaskDetailDto(detail) });
}

// DELETE /programs/:programId/tasks/:taskRef
export async function remove(req: Request, res: Response): Promise<void> {
  const { programId, taskRef } = taskRefParamSchema.parse(req.params);
  await taskService.deleteTask(programId, taskRef, req.auth!);
  res.status(204).end();
}

// POST /programs/:programId/tasks/:taskRef/dependencies
export async function addDependency(req: Request, res: Response): Promise<void> {
  const { programId, taskRef } = taskRefParamSchema.parse(req.params);
  const { dependsOnTaskId } = addDependencySchema.parse(req.body);
  const detail = await taskService.addDependency(programId, taskRef, dependsOnTaskId);
  res.status(201).json({ data: toTaskDetailDto(detail) });
}

// DELETE /programs/:programId/tasks/:taskRef/dependencies/:dependsOnTaskId
export async function removeDependency(req: Request, res: Response): Promise<void> {
  const { programId, taskRef, dependsOnTaskId } = dependencyParamSchema.parse(req.params);
  const detail = await taskService.removeDependency(programId, taskRef, dependsOnTaskId);
  res.json({ data: toTaskDetailDto(detail) });
}
