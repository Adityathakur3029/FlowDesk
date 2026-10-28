import type { Request, Response } from "express";
import * as boardService from "./board.service";
import * as taskService from "../tasks/task.service";
import { boardParent } from "../tasks/task.parent";
import { toBoardDto } from "./board.dto";
import { boardIdParamSchema, createBoardSchema, listBoardsQuerySchema, updateBoardSchema } from "./board.validation";

// POST /boards
export async function create(req: Request, res: Response): Promise<void> {
  const input = createBoardSchema.parse(req.body);
  const board = await boardService.createBoard(input);
  res.status(201).json({ data: toBoardDto(board) });
}

// GET /boards?q=&limit=&offset=
export async function list(req: Request, res: Response): Promise<void> {
  const query = listBoardsQuerySchema.parse(req.query);
  const page = await boardService.listBoards(query);
  res.json({
    data: page.items.map(toBoardDto),
    meta: { total: page.total, limit: page.limit, offset: page.offset },
  });
}

// GET /boards/:boardId
export async function getById(req: Request, res: Response): Promise<void> {
  const { boardId } = boardIdParamSchema.parse(req.params);
  const board = await boardService.getActiveBoard(boardId);
  res.json({ data: toBoardDto(board) });
}

// PATCH /boards/:boardId
export async function update(req: Request, res: Response): Promise<void> {
  const { boardId } = boardIdParamSchema.parse(req.params);
  const input = updateBoardSchema.parse(req.body);
  const board = await boardService.updateBoard(boardId, input);
  res.json({ data: toBoardDto(board) });
}

// DELETE /boards/:boardId
export async function remove(req: Request, res: Response): Promise<void> {
  const { boardId } = boardIdParamSchema.parse(req.params);
  await boardService.deleteBoard(boardId);
  res.status(204).end();
}

// GET /boards/:boardId/labels
export async function listLabels(req: Request, res: Response): Promise<void> {
  const { boardId } = boardIdParamSchema.parse(req.params);
  const labels = await taskService.listLabels(boardParent(boardId));
  res.json({ data: labels });
}
