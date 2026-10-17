import { and, eq } from "drizzle-orm";
import { withTransaction, type DbExecutor } from "../../db";
import { programs, type Program } from "../../db/schema";
import type { Page } from "../../db/repository";
import { BadRequestError, ConflictError, getPgErrorCode, NotFoundError, PG_UNIQUE_VIOLATION } from "../../lib/errors";
import { teamRepository } from "../teams/team.repository";
import { programRepository } from "./program.repository";
import type { CreateProgramInput, ListProgramsQuery, UpdateProgramInput } from "./program.validation";

const keyTaken = (key: string) => new ConflictError(`Program key ${key} is already taken`, "PROGRAM_KEY_EXISTS");

// Locks the owner team FOR SHARE until the transaction ends, so it can't be deleted
// while a program is attached to it. See .claude/specs/06-teams.md
async function lockOwnerTeam(tx: DbExecutor, teamId: string): Promise<void> {
  const team = await teamRepository.withTx(tx).lockForShare(teamId);
  if (!team) throw new BadRequestError("Owner team not found", "OWNER_TEAM_NOT_FOUND");
}

export async function createProgram(input: CreateProgramInput): Promise<Program> {
  try {
    return await withTransaction(async (tx) => {
      await lockOwnerTeam(tx, input.ownerTeamId);

      const repo = programRepository.withTx(tx);
      // Keys of soft-deleted programs stay taken: the unique constraint covers them
      const existing = await repo.findByKey(input.key, { includeInactive: true });
      if (existing) throw keyTaken(input.key);

      return repo.create({
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        status: input.status,
        ownerTeamId: input.ownerTeamId,
      });
    });
  } catch (err) {
    // Lost a race with a concurrent create of the same key
    if (getPgErrorCode(err) === PG_UNIQUE_VIOLATION) throw keyTaken(input.key);
    throw err;
  }
}

// Unknown and soft-deleted programs are both 404, here and on every route under a program
export async function getActiveProgram(id: string): Promise<Program> {
  const program = await programRepository.findById(id);
  if (!program) throw new NotFoundError("Program not found");
  return program;
}

export function listPrograms(query: ListProgramsQuery): Promise<Page<Program>> {
  return programRepository.findPage({
    where: and(
      query.status ? eq(programs.status, query.status) : undefined,
      query.ownerTeamId ? eq(programs.ownerTeamId, query.ownerTeamId) : undefined,
      query.q ? programRepository.searchWhere(query.q) : undefined,
    ),
    limit: query.limit,
    offset: query.offset,
  });
}

export function updateProgram(id: string, input: UpdateProgramInput): Promise<Program> {
  return withTransaction(async (tx) => {
    const repo = programRepository.withTx(tx);
    if (!(await repo.findById(id))) throw new NotFoundError("Program not found");
    if (input.ownerTeamId) await lockOwnerTeam(tx, input.ownerTeamId);

    const updated = await repo.updateById(id, input);
    if (!updated) throw new NotFoundError("Program not found");
    return updated;
  });
}

// Soft delete; the program's tasks stay but every route under it returns 404
export async function deleteProgram(id: string): Promise<void> {
  await getActiveProgram(id);
  await programRepository.deactivate(id);
}
