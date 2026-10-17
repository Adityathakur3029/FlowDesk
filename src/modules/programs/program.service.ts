import { and, eq } from "drizzle-orm";
import { programs, type Program } from "../../db/schema";
import type { Page } from "../../db/repository";
import { ConflictError, getPgErrorCode, NotFoundError, PG_UNIQUE_VIOLATION } from "../../lib/errors";
import { programRepository } from "./program.repository";
import type { CreateProgramInput, ListProgramsQuery, UpdateProgramInput } from "./program.validation";

const keyTaken = (key: string) => new ConflictError(`Program key ${key} is already taken`, "PROGRAM_KEY_EXISTS");

export async function createProgram(input: CreateProgramInput): Promise<Program> {
  // Keys of soft-deleted programs stay taken: the unique constraint covers them
  const existing = await programRepository.findByKey(input.key, { includeInactive: true });
  if (existing) throw keyTaken(input.key);

  try {
    return await programRepository.create({
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      status: input.status,
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
      query.q ? programRepository.searchWhere(query.q) : undefined,
    ),
    limit: query.limit,
    offset: query.offset,
  });
}

export async function updateProgram(id: string, input: UpdateProgramInput): Promise<Program> {
  await getActiveProgram(id);
  const updated = await programRepository.updateById(id, input);
  if (!updated) throw new NotFoundError("Program not found");
  return updated;
}

// Soft delete; the program's tasks stay but every route under it returns 404
export async function deleteProgram(id: string): Promise<void> {
  await getActiveProgram(id);
  await programRepository.deactivate(id);
}
