import type { Request, Response } from "express";
import * as programService from "./program.service";
import * as taskService from "../tasks/task.service";
import { programParent } from "../tasks/task.parent";
import { toProgramDto } from "./program.dto";
import {
  createProgramSchema,
  listProgramsQuerySchema,
  programIdParamSchema,
  updateProgramSchema,
} from "./program.validation";

// POST /programs
export async function create(req: Request, res: Response): Promise<void> {
  const input = createProgramSchema.parse(req.body);
  const program = await programService.createProgram(input);
  res.status(201).json({ data: toProgramDto(program) });
}

// GET /programs?status=&q=&limit=&offset=
export async function list(req: Request, res: Response): Promise<void> {
  const query = listProgramsQuerySchema.parse(req.query);
  const page = await programService.listPrograms(query);
  res.json({
    data: page.items.map(toProgramDto),
    meta: { total: page.total, limit: page.limit, offset: page.offset },
  });
}

// GET /programs/:programId
export async function getById(req: Request, res: Response): Promise<void> {
  const { programId } = programIdParamSchema.parse(req.params);
  const program = await programService.getActiveProgram(programId);
  res.json({ data: toProgramDto(program) });
}

// PATCH /programs/:programId
export async function update(req: Request, res: Response): Promise<void> {
  const { programId } = programIdParamSchema.parse(req.params);
  const input = updateProgramSchema.parse(req.body);
  const program = await programService.updateProgram(programId, input);
  res.json({ data: toProgramDto(program) });
}

// DELETE /programs/:programId
export async function remove(req: Request, res: Response): Promise<void> {
  const { programId } = programIdParamSchema.parse(req.params);
  await programService.deleteProgram(programId);
  res.status(204).end();
}

// GET /programs/:programId/labels
export async function listLabels(req: Request, res: Response): Promise<void> {
  const { programId } = programIdParamSchema.parse(req.params);
  const labels = await taskService.listLabels(programParent(programId));
  res.json({ data: labels });
}
