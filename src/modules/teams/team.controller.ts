import type { Request, Response } from "express";
import * as teamService from "./team.service";
import { toTeamDto } from "./team.dto";
import { toEmployeeDto } from "../employees/employee.dto";
import {
  createTeamSchema,
  listTeamMembersQuerySchema,
  listTeamsQuerySchema,
  teamIdParamSchema,
  teamMemberParamSchema,
  updateTeamSchema,
} from "./team.validation";

// POST /teams
export async function create(req: Request, res: Response): Promise<void> {
  const input = createTeamSchema.parse(req.body);
  const team = await teamService.createTeam(input);
  res.status(201).json({ data: toTeamDto(team) });
}

// GET /teams?q=&limit=&offset=
export async function list(req: Request, res: Response): Promise<void> {
  const query = listTeamsQuerySchema.parse(req.query);
  const page = await teamService.listTeams(query);
  res.json({
    data: page.items.map(toTeamDto),
    meta: { total: page.total, limit: page.limit, offset: page.offset },
  });
}

// GET /teams/:teamId
export async function getById(req: Request, res: Response): Promise<void> {
  const { teamId } = teamIdParamSchema.parse(req.params);
  const team = await teamService.getTeam(teamId);
  res.json({ data: toTeamDto(team) });
}

// PATCH /teams/:teamId
export async function update(req: Request, res: Response): Promise<void> {
  const { teamId } = teamIdParamSchema.parse(req.params);
  const input = updateTeamSchema.parse(req.body);
  const team = await teamService.updateTeam(teamId, input);
  res.json({ data: toTeamDto(team) });
}

// DELETE /teams/:teamId
export async function remove(req: Request, res: Response): Promise<void> {
  const { teamId } = teamIdParamSchema.parse(req.params);
  await teamService.deleteTeam(teamId);
  res.status(204).end();
}

// GET /teams/:teamId/members?limit=&offset=
export async function listMembers(req: Request, res: Response): Promise<void> {
  const { teamId } = teamIdParamSchema.parse(req.params);
  const query = listTeamMembersQuerySchema.parse(req.query);
  const page = await teamService.listMembers(teamId, query);
  res.json({
    data: page.items.map(toEmployeeDto),
    meta: { total: page.total, limit: page.limit, offset: page.offset },
  });
}

// PUT /teams/:teamId/members/:employeeId
export async function addMember(req: Request, res: Response): Promise<void> {
  const { teamId, employeeId } = teamMemberParamSchema.parse(req.params);
  const result = await teamService.addMember(teamId, employeeId);
  res.json({ data: { employee: toEmployeeDto(result.employee), previousTeamId: result.previousTeamId } });
}

// DELETE /teams/:teamId/members/:employeeId
export async function removeMember(req: Request, res: Response): Promise<void> {
  const { teamId, employeeId } = teamMemberParamSchema.parse(req.params);
  await teamService.removeMember(teamId, employeeId);
  res.status(204).end();
}
