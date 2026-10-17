import type { Program } from "../../db/schema";

// Public shape of a program (matches programSchema in program.docs.ts).
// task_counter is internal and never returned.
export function toProgramDto(program: Program) {
  return {
    id: program.id,
    createdAt: program.createdAt,
    updatedAt: program.updatedAt,
    isActive: program.isActive,
    key: program.key,
    name: program.name,
    description: program.description,
    status: program.status,
    ownerTeamId: program.ownerTeamId,
  };
}

export type ProgramDto = ReturnType<typeof toProgramDto>;
