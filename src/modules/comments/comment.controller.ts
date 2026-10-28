import type { Request, Response } from "express";
import * as commentService from "./comment.service";
import { toCommentDto } from "./comment.dto";
import { programIdParamSchema } from "../programs/program.validation";
import { parseTaskLocator } from "../tasks/task.validation";
import {
  commentIdParamSchema,
  createCommentSchema,
  listCommentsQuerySchema,
  taskCommentIdParamSchema,
  updateCommentSchema,
} from "./comment.validation";

type CommentPage = Awaited<ReturnType<typeof commentService.listProgramComments>>;

function sendPage(res: Response, page: CommentPage): void {
  res.json({
    data: page.items.map(toCommentDto),
    meta: { total: page.total, limit: page.limit, offset: page.offset },
  });
}

// GET /programs/:programId/comments?order=&limit=&offset=
export async function listForProgram(req: Request, res: Response): Promise<void> {
  const { programId } = programIdParamSchema.parse(req.params);
  const query = listCommentsQuerySchema.parse(req.query);
  sendPage(res, await commentService.listProgramComments(programId, query));
}

// POST /programs/:programId/comments
export async function createForProgram(req: Request, res: Response): Promise<void> {
  const { programId } = programIdParamSchema.parse(req.params);
  const input = createCommentSchema.parse(req.body);
  const view = await commentService.createProgramComment(programId, input, req.auth!.employeeId);
  res.status(201).json({ data: toCommentDto(view) });
}

// GET /programs/:programId/tasks/:taskRef/comments, GET /tasks/:taskRef/comments (?order=&limit=&offset=)
export async function listForTask(req: Request, res: Response): Promise<void> {
  const locator = parseTaskLocator(req.params);
  const query = listCommentsQuerySchema.parse(req.query);
  sendPage(res, await commentService.listTaskComments(locator, query));
}

// POST /programs/:programId/tasks/:taskRef/comments, POST /tasks/:taskRef/comments
export async function createForTask(req: Request, res: Response): Promise<void> {
  const locator = parseTaskLocator(req.params);
  const input = createCommentSchema.parse(req.body);
  const view = await commentService.createTaskComment(locator, input, req.auth!.employeeId);
  res.status(201).json({ data: toCommentDto(view) });
}

// GET /tasks/:taskRef/comments/:commentId
export async function getForTask(req: Request, res: Response): Promise<void> {
  const { taskRef, commentId } = taskCommentIdParamSchema.parse(req.params);
  const view = await commentService.getTaskComment(taskRef, commentId);
  res.json({ data: toCommentDto(view) });
}

// PATCH /tasks/:taskRef/comments/:commentId
export async function updateForTask(req: Request, res: Response): Promise<void> {
  const { taskRef, commentId } = taskCommentIdParamSchema.parse(req.params);
  const input = updateCommentSchema.parse(req.body);
  const view = await commentService.updateTaskComment(taskRef, commentId, input, req.auth!);
  res.json({ data: toCommentDto(view) });
}

// DELETE /tasks/:taskRef/comments/:commentId
export async function removeForTask(req: Request, res: Response): Promise<void> {
  const { taskRef, commentId } = taskCommentIdParamSchema.parse(req.params);
  await commentService.deleteTaskComment(taskRef, commentId, req.auth!);
  res.status(204).end();
}

// GET /programs/:programId/comments/:commentId
export async function getById(req: Request, res: Response): Promise<void> {
  const { programId, commentId } = commentIdParamSchema.parse(req.params);
  const view = await commentService.getComment(programId, commentId);
  res.json({ data: toCommentDto(view) });
}

// PATCH /programs/:programId/comments/:commentId
export async function update(req: Request, res: Response): Promise<void> {
  const { programId, commentId } = commentIdParamSchema.parse(req.params);
  const input = updateCommentSchema.parse(req.body);
  const view = await commentService.updateComment(programId, commentId, input, req.auth!);
  res.json({ data: toCommentDto(view) });
}

// DELETE /programs/:programId/comments/:commentId
export async function remove(req: Request, res: Response): Promise<void> {
  const { programId, commentId } = commentIdParamSchema.parse(req.params);
  await commentService.deleteComment(programId, commentId, req.auth!);
  res.status(204).end();
}
