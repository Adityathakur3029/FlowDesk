import type { TeamWithCount } from "./team.repository";

// Public shape of a team (matches teamSchema in team.docs.ts)
export function toTeamDto(team: TeamWithCount) {
  return {
    id: team.id,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
    isActive: team.isActive,
    name: team.name,
    description: team.description,
    memberCount: team.memberCount,
  };
}

export type TeamDto = ReturnType<typeof toTeamDto>;
