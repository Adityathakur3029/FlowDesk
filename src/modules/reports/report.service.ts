import { withReadSnapshot, type DbExecutor } from "../../db";
import { programStatus, taskPriority, taskStatus, type ProgramStatus, type TaskPriority, type TaskStatus } from "../../db/schema";
import { resolvePeriod, type ReportPeriod } from "./report.period";
import { reportRepository, type ProgramReportRow } from "./report.repository";
import type { OverviewReportQuery } from "./report.validation";

// Builds GET /reports/overview. Every query runs in one read-only snapshot so the numbers
// add up; the per-program rows are rolled up here. See .claude/specs/09-overview-report.md

const CLOSED_STATUSES: ReadonlySet<ProgramStatus> = new Set(["COMPLETED", "CANCELLED"]);
// Response order: most urgent first
const PRIORITY_ORDER: readonly TaskPriority[] = [...taskPriority.enumValues].reverse();

const zeroCounts = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

const byName = (a: string | null, b: string | null) => {
  const x = a?.toLowerCase() ?? "";
  const y = b?.toLowerCase() ?? "";
  return x < y ? -1 : x > y ? 1 : 0;
};

function toProgramRow(row: ProgramReportRow, asOf: string) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    status: row.status,
    ownerTeam: row.ownerTeamId ? { id: row.ownerTeamId, name: row.ownerTeamName! } : null,
    startDate: row.startDate,
    endDate: row.endDate,
    completedAt: row.completedAt,
    tasksTotal: row.tasksTotal,
    tasksDone: row.tasksDone,
    tasksCompletedInPeriod: row.tasksCompletedInPeriod,
    openTasks: row.openTasks,
    overdueTasks: row.overdueTasks,
    atRisk: row.endDate !== null && row.endDate < asOf && !CLOSED_STATUSES.has(row.status),
  };
}

type ProgramRow = ReturnType<typeof toProgramRow>;

interface TeamRow {
  teamId: string | null;
  name: string | null;
  programs: number;
  tasksCompleted: number;
  openTasks: number;
  overdueTasks: number;
}

// One row per owner team; programs without a (live) owner team share the null row, listed last
function rollUpTeams(rows: ProgramRow[]): TeamRow[] {
  const teams = new Map<string | null, TeamRow>();
  for (const p of rows) {
    const teamId = p.ownerTeam?.id ?? null;
    let team = teams.get(teamId);
    if (!team) {
      team = { teamId, name: p.ownerTeam?.name ?? null, programs: 0, tasksCompleted: 0, openTasks: 0, overdueTasks: 0 };
      teams.set(teamId, team);
    }
    team.programs += 1;
    team.tasksCompleted += p.tasksCompletedInPeriod;
    team.openTasks += p.openTasks;
    team.overdueTasks += p.overdueTasks;
  }
  return [...teams.values()].sort((a, b) => {
    if (a.teamId === null || b.teamId === null) return a.teamId === null ? 1 : -1;
    return byName(a.name, b.name) || (a.teamId < b.teamId ? -1 : 1);
  });
}

// atRisk first, then most overdue, then name, then id (a total order)
function compareProgramRows(a: ProgramRow, b: ProgramRow): number {
  if (a.atRisk !== b.atRisk) return a.atRisk ? -1 : 1;
  if (a.overdueTasks !== b.overdueTasks) return b.overdueTasks - a.overdueTasks;
  return byName(a.name, b.name) || (a.id < b.id ? -1 : 1);
}

async function buildReport(executor: DbExecutor, p: ReportPeriod) {
  const repo = reportRepository.withTx(executor);
  // Sequential: a transaction runs one query at a time on its connection anyway
  const programRows = await repo.programRows(p.period, p.asOf);
  const events = await repo.taskEventTotals(p.period, p.previous);
  const statusCounts = await repo.tasksByStatus(p.period);
  const priorityCounts = await repo.openTasksByPriority(p.period);
  const createdPerBucket = await repo.createdPerBucket(p.period, p.granularity);
  const completedPerBucket = await repo.completedPerBucket(p.period, p.granularity);

  const programs = programRows.map((row) => toProgramRow(row, p.asOf)).sort(compareProgramRows);

  const programsByStatus = zeroCounts(programStatus.enumValues);
  for (const row of programs) programsByStatus[row.status] += 1;

  const tasksByStatus = zeroCounts<TaskStatus>(taskStatus.enumValues);
  for (const { status, count } of statusCounts) tasksByStatus[status] = count;

  const openTasksByPriority = zeroCounts(PRIORITY_ORDER);
  for (const { priority, count } of priorityCounts) openTasksByPriority[priority] = count;

  const created = new Map(createdPerBucket.map((r) => [r.bucket, r.count]));
  const completed = new Map(completedPerBucket.map((r) => [r.bucket, r.count]));
  const trend = p.buckets.map((b) => ({
    start: b.start,
    end: b.end,
    created: created.get(b.key) ?? 0,
    completed: completed.get(b.key) ?? 0,
  }));

  const sum = (pick: (row: ProgramRow) => number) => programs.reduce((total, row) => total + pick(row), 0);
  const inPeriod = (at: Date | null) => at !== null && at >= p.period.start && at < p.period.end;

  return {
    period: { from: p.period.from, to: p.period.to, days: p.period.days, granularity: p.granularity },
    previousPeriod: { from: p.previous.from, to: p.previous.to, days: p.previous.days },
    asOf: p.asOf,
    totals: {
      programs: programs.length,
      programsCompleted: programs.filter((row) => row.status === "COMPLETED" && inPeriod(row.completedAt)).length,
      programsAtRisk: programs.filter((row) => row.atRisk).length,
      tasksCreated: events.created,
      tasksCreatedPrevious: events.createdPrevious,
      tasksCompleted: events.completed,
      tasksCompletedPrevious: events.completedPrevious,
      tasksCompletedWithDueDate: events.completedWithDueDate,
      tasksCompletedOnTime: events.completedOnTime,
      openTasks: sum((row) => row.openTasks),
      overdueTasks: sum((row) => row.overdueTasks),
    },
    programsByStatus,
    tasksByStatus,
    openTasksByPriority,
    trend,
    teams: rollUpTeams(programs),
    programs,
  };
}

export type OverviewReport = Awaited<ReturnType<typeof buildReport>>;

// `now` fixes "today" (asOf); `executor` runs the queries in an existing transaction (tests)
export function getOverviewReport(
  query: OverviewReportQuery,
  now: Date = new Date(),
  executor?: DbExecutor,
): Promise<OverviewReport> {
  const period = resolvePeriod(query.from, query.to, now);
  return executor ? buildReport(executor, period) : withReadSnapshot((tx) => buildReport(tx, period));
}
