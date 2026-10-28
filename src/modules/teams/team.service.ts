import { withTransaction } from "../../db";
import type { Employee } from "../../db/schema";
import type { Page } from "../../db/repository";
import { ConflictError, getPgErrorCode, NotFoundError, PG_UNIQUE_VIOLATION } from "../../lib/errors";
import { employeeRepository } from "../employees/employee.repository";
import { programRepository } from "../programs/program.repository";
import { teamRepository, type TeamWithCount } from "./team.repository";
import type { CreateTeamInput, ListTeamMembersQuery, ListTeamsQuery, UpdateTeamInput } from "./team.validation";

// How many owned programs TEAM_OWNS_PROGRAMS lists in `details`
const OWNED_PROGRAMS_IN_ERROR = 20;

const nameTaken = (name: string) => new ConflictError(`Team name ${name} is already taken`, "TEAM_NAME_EXISTS");
const teamNotFound = () => new NotFoundError("Team not found");

// Another active team already has this name (ignoring case)
async function assertNameFree(name: string, exceptId?: string): Promise<void> {
  const existing = await teamRepository.findByName(name);
  if (existing && existing.id !== exceptId) throw nameTaken(name);
}

// Lost a race with a concurrent create/rename to the same name
function mapNameRace(err: unknown, name: string | undefined): never {
  if (name !== undefined && getPgErrorCode(err) === PG_UNIQUE_VIOLATION) throw nameTaken(name);
  throw err;
}

export async function createTeam(input: CreateTeamInput): Promise<TeamWithCount> {
  await assertNameFree(input.name);
  try {
    const team = await teamRepository.create({ name: input.name, description: input.description ?? null });
    return { ...team, memberCount: 0 };
  } catch (err) {
    mapNameRace(err, input.name);
  }
}

export async function getTeam(id: string): Promise<TeamWithCount> {
  const team = await teamRepository.findByIdWithCount(id);
  if (!team) throw teamNotFound();
  return team;
}

export function listTeams(query: ListTeamsQuery): Promise<Page<TeamWithCount>> {
  return teamRepository.findPageWithCounts({
    where: query.q ? teamRepository.nameSearchWhere(query.q) : undefined,
    limit: query.limit,
    offset: query.offset,
  });
}

export async function updateTeam(id: string, input: UpdateTeamInput): Promise<TeamWithCount> {
  await getTeam(id);
  if (input.name !== undefined) await assertNameFree(input.name, id);
  try {
    const updated = await teamRepository.updateById(id, input);
    if (!updated) throw teamNotFound();
  } catch (err) {
    mapNameRace(err, input.name);
  }
  return getTeam(id);
}

// Blocked while the team owns an active program; releases its members otherwise
export function deleteTeam(id: string): Promise<void> {
  return withTransaction(async (tx) => {
    const teams = teamRepository.withTx(tx);
    if (!(await teams.lockForUpdate(id))) throw teamNotFound();

    const owned = await programRepository.withTx(tx).findActiveByOwnerTeam(id, OWNED_PROGRAMS_IN_ERROR);
    if (owned.length > 0) {
      throw new ConflictError(
        "Team still owns active programs; move them to another team first",
        "TEAM_OWNS_PROGRAMS",
        { programs: owned },
      );
    }

    await employeeRepository.withTx(tx).clearTeam(id);
    await teams.deactivate(id);
  });
}

export async function listMembers(teamId: string, query: ListTeamMembersQuery): Promise<Page<Employee>> {
  await getTeam(teamId);
  return employeeRepository.findTeamMembersPage(teamId, query);
}

// Adds the employee to the team, moving them out of any other one. Idempotent.
export function addMember(
  teamId: string,
  employeeId: string,
): Promise<{ employee: Employee; previousTeamId: string | null }> {
  return withTransaction(async (tx) => {
    // FOR SHARE: a concurrent delete of this team waits until we commit
    if (!(await teamRepository.withTx(tx).lockForShare(teamId))) throw teamNotFound();

    const employees = employeeRepository.withTx(tx);
    const employee = await employees.findById(employeeId);
    if (!employee) throw new NotFoundError("Employee not found");

    const previousTeamId = employee.teamId;
    if (previousTeamId === teamId) return { employee, previousTeamId };

    const updated = await employees.setTeam(employeeId, teamId);
    return { employee: updated!, previousTeamId };
  });
}

export async function removeMember(teamId: string, employeeId: string): Promise<void> {
  await getTeam(teamId);
  const employee = await employeeRepository.findById(employeeId);
  if (!employee || employee.teamId !== teamId) throw new NotFoundError("Team member not found");
  await employeeRepository.setTeam(employeeId, null);
}
