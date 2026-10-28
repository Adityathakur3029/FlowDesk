import { and, eq } from "drizzle-orm";
import { withTransaction, type DbExecutor } from "../../db";
import { programs, type Program, type ProgramStatus } from "../../db/schema";
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

function assertDateRange(startDate: string | null | undefined, endDate: string | null | undefined): void {
  // YYYY-MM-DD strings compare correctly as text
  if (startDate && endDate && endDate < startDate) {
    throw new BadRequestError("endDate must be on or after startDate", "INVALID_DATE_RANGE");
  }
}

// completed_at / cancelled_at follow the status: set on entering COMPLETED / CANCELLED,
// cleared on leaving it. A DB check enforces it. See .claude/specs/09-overview-report.md
function finishTimes(status: ProgramStatus, now = new Date()): Pick<Program, "completedAt" | "cancelledAt"> {
  return {
    completedAt: status === "COMPLETED" ? now : null,
    cancelledAt: status === "CANCELLED" ? now : null,
  };
}

export async function createProgram(input: CreateProgramInput): Promise<Program> {
  assertDateRange(input.startDate, input.endDate);
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
        ...finishTimes(input.status),
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
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
    // Locked so two concurrent date edits can't each pass the merged check
    const program = await repo.lockForUpdate(id);
    if (!program) throw new NotFoundError("Program not found");
    // Check the merged values, so changing one date can't break the range
    assertDateRange(
      input.startDate !== undefined ? input.startDate : program.startDate,
      input.endDate !== undefined ? input.endDate : program.endDate,
    );
    if (input.ownerTeamId) await lockOwnerTeam(tx, input.ownerTeamId);

    // Sending the current status again keeps the existing timestamp
    const statusChange = input.status && input.status !== program.status ? finishTimes(input.status) : {};
    const updated = await repo.updateById(id, { ...input, ...statusChange });
    if (!updated) throw new NotFoundError("Program not found");
    return updated;
  });
}

// Soft delete; the program's tasks stay but every route under it returns 404
export async function deleteProgram(id: string): Promise<void> {
  await getActiveProgram(id);
  await programRepository.deactivate(id);
}
