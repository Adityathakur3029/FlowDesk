import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import { db, pool, type Transaction } from "../../db";
import { employees, programs, tasks, teams, type NewProgram, type NewTask } from "../../db/schema";
import { getOverviewReport, type OverviewReport } from "./report.service";

// Runs against DATABASE_URL. Every test works in a transaction that is always rolled back,
// and first hides the existing programs inside it, so it sees only its own fixtures.
// See "Testing notes" in .claude/specs/09-overview-report.md

const NOW = new Date("2026-10-20T12:00:00Z"); // asOf 2026-10-20, after the period below
// 91 days (weekly); previous period 2026-04-01 .. 2026-06-30
const PERIOD = { from: "2026-07-01", to: "2026-09-29" };

class Rollback extends Error {}

interface Fixture {
  tx: Transaction;
  program(values?: Partial<NewProgram>): Promise<string>;
  task(programId: string, values?: Partial<NewTask>): Promise<string>;
  team(name: string, isActive?: boolean): Promise<string>;
  report(query?: { from: string; to: string }): Promise<OverviewReport>;
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.update(programs).set({ isActive: false }).where(eq(programs.isActive, true));
      const [reporter] = await tx
        .insert(employees)
        .values({ emailId: `report-test-${randomUUID()}@example.test`, name: "Report Tester" })
        .returning();
      const taskNumbers = new Map<string, number>();
      const programKeys = new Map<string, string>();

      const f: Fixture = {
        tx,
        async program(values = {}) {
          const key = `R${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
          const [row] = await tx
            .insert(programs)
            .values({ key, name: key, createdAt: new Date("2026-01-01T00:00:00Z"), status: "ACTIVE", ...values })
            .returning();
          programKeys.set(row!.id, key);
          return row!.id;
        },
        async task(programId, values = {}) {
          const number = (taskNumbers.get(programId) ?? 0) + 1;
          taskNumbers.set(programId, number);
          const [row] = await tx
            .insert(tasks)
            .values({
              programId,
              number,
              key: `${programKeys.get(programId)}-${number}`,
              title: "t",
              reporterId: reporter!.id,
              createdAt: new Date("2026-07-02T00:00:00Z"),
              ...values,
            })
            .returning();
          return row!.id;
        },
        async team(name, isActive = true) {
          const [row] = await tx.insert(teams).values({ name: `${name} ${randomUUID()}`, isActive }).returning();
          return row!.id;
        },
        report: (query = PERIOD) => getOverviewReport(query, NOW, tx),
      };
      await fn(f);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

const done = (completedAt: string, values: Partial<NewTask> = {}): Partial<NewTask> => ({
  status: "DONE",
  completedAt: new Date(completedAt),
  ...values,
});

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

// The totals the spec says always add up
function assertInvariants(r: OverviewReport): void {
  assert.equal(sum(Object.values(r.programsByStatus)), r.totals.programs);
  assert.equal(r.programs.length, r.totals.programs);
  assert.equal(r.programs.filter((p) => p.atRisk).length, r.totals.programsAtRisk);
  assert.equal(sum(Object.values(r.openTasksByPriority)), r.totals.openTasks);
  assert.equal(sum(r.programs.map((p) => p.openTasks)), r.totals.openTasks);
  assert.equal(sum(r.teams.map((t) => t.openTasks)), r.totals.openTasks);
  assert.equal(sum(r.programs.map((p) => p.overdueTasks)), r.totals.overdueTasks);
  assert.equal(sum(r.trend.map((b) => b.created)), r.totals.tasksCreated);
  assert.equal(sum(r.trend.map((b) => b.completed)), r.totals.tasksCompleted);
}

after(() => pool.end());

describe("getOverviewReport", () => {
  test("empty organisation: zeros, every key, buckets present", () =>
    withFixture(async (f) => {
      const r = await f.report();
      assert.deepEqual(r.period, { from: "2026-07-01", to: "2026-09-29", days: 91, granularity: "week" });
      assert.deepEqual(r.previousPeriod, { from: "2026-04-01", to: "2026-06-30", days: 91 });
      assert.equal(r.asOf, "2026-10-20");
      assert.ok(Object.values(r.totals).every((v) => v === 0));
      assert.deepEqual(r.programsByStatus, { PLANNED: 0, ACTIVE: 0, ON_HOLD: 0, COMPLETED: 0, CANCELLED: 0 });
      assert.deepEqual(r.tasksByStatus, { DISCUSSION: 0, ON_HOLD: 0, IN_PROGRESS: 0, DONE: 0, DEPENDENT: 0 });
      assert.deepEqual(Object.keys(r.openTasksByPriority), ["HIGHEST", "HIGH", "MEDIUM", "LOW", "LOWEST"]);
      assert.equal(r.trend.length, 14);
      assert.ok(r.trend.every((b) => b.created === 0 && b.completed === 0));
      assert.deepEqual([r.teams, r.programs], [[], []]);
    }));

  test("program scope: finished before from, created after to and deleted programs are excluded", () =>
    withFixture(async (f) => {
      await f.program({ status: "COMPLETED", completedAt: new Date("2026-06-30T23:59:59Z") });
      await f.program({ status: "CANCELLED", cancelledAt: new Date("2026-05-01T00:00:00Z") });
      await f.program({ createdAt: new Date("2026-09-30T00:00:00Z") });
      await f.program({ isActive: false });
      const finishedAtFrom = await f.program({ status: "COMPLETED", completedAt: new Date("2026-07-01T00:00:00Z") });
      const open = await f.program();
      const createdLastInstant = await f.program({ status: "PLANNED", createdAt: new Date("2026-09-29T23:59:59Z") });
      const completedAfterTo = await f.program({ status: "COMPLETED", completedAt: new Date("2026-10-05T00:00:00Z") });
      const cancelledInPeriod = await f.program({ status: "CANCELLED", cancelledAt: new Date("2026-08-01T00:00:00Z") });

      const r = await f.report();
      assert.deepEqual(
        new Set(r.programs.map((p) => p.id)),
        new Set([finishedAtFrom, open, createdLastInstant, completedAfterTo, cancelledInPeriod]),
      );
      assert.deepEqual(r.programsByStatus, { PLANNED: 1, ACTIVE: 1, ON_HOLD: 0, COMPLETED: 2, CANCELLED: 1 });
      assert.equal(r.totals.programsCompleted, 1); // completed after `to` is in scope but not "completed in the period"
      assertInvariants(r);
    }));

  test("tasks: on time vs late, overdue against asOf, open as of now, deleted rows excluded", () =>
    withFixture(async (f) => {
      const teamId = await f.team("Research");
      const p = await f.program({ ownerTeamId: teamId, endDate: "2026-10-01" });
      await f.task(p, done("2026-07-10T10:00:00Z", { dueDate: "2026-07-10" })); // on time (same day)
      await f.task(p, done("2026-07-11T00:30:00Z", { dueDate: "2026-07-10" })); // late
      await f.task(p, done("2026-07-12T00:00:00Z")); // no due date
      await f.task(p, { status: "IN_PROGRESS", dueDate: "2026-10-19", priority: "HIGH" }); // overdue (after `to`, before asOf)
      await f.task(p, { status: "DISCUSSION", dueDate: "2026-10-20", priority: "HIGH" }); // due today: not overdue
      await f.task(p, { status: "ON_HOLD", priority: "LOW" }); // no due date: never overdue
      await f.task(p, done("2026-07-15T00:00:00Z", { isActive: false })); // deleted
      await f.task(p, done("2026-06-15T00:00:00Z", { createdAt: new Date("2026-05-01T00:00:00Z") })); // previous period
      await f.task(p, { createdAt: new Date("2026-10-01T00:00:00Z") }); // created after `to`, open now
      const deletedProgram = await f.program({ isActive: false });
      await f.task(deletedProgram, done("2026-07-20T00:00:00Z"));

      const r = await f.report();
      assert.deepEqual(r.totals, {
        programs: 1,
        programsCompleted: 0,
        programsAtRisk: 1,
        tasksCreated: 6,
        tasksCreatedPrevious: 1,
        tasksCompleted: 3,
        tasksCompletedPrevious: 1,
        tasksCompletedWithDueDate: 2,
        tasksCompletedOnTime: 1,
        openTasks: 4,
        overdueTasks: 1,
      });
      // The task created after `to` is open now but wasn't live in the period
      assert.deepEqual(r.tasksByStatus, { DISCUSSION: 1, ON_HOLD: 1, IN_PROGRESS: 1, DONE: 3, DEPENDENT: 0 });
      assert.deepEqual(r.openTasksByPriority, { HIGHEST: 0, HIGH: 2, MEDIUM: 1, LOW: 1, LOWEST: 0 });
      assert.deepEqual(
        { ...r.programs[0], id: undefined, key: undefined, name: undefined, ownerTeam: undefined },
        {
          id: undefined,
          key: undefined,
          name: undefined,
          ownerTeam: undefined,
          status: "ACTIVE",
          startDate: null,
          endDate: "2026-10-01",
          completedAt: null,
          tasksTotal: 8,
          tasksDone: 4,
          tasksCompletedInPeriod: 3,
          openTasks: 4,
          overdueTasks: 1,
          atRisk: true,
        },
      );
      assert.equal(r.teams.length, 1);
      assert.deepEqual({ ...r.teams[0], name: undefined }, {
        teamId,
        name: undefined,
        programs: 1,
        tasksCompleted: 3,
        openTasks: 4,
        overdueTasks: 1,
      });
      assertInvariants(r);
    }));

  test("a reopened task counts only in the window of its last completion; a reopened one isn't completed", () =>
    withFixture(async (f) => {
      const p = await f.program();
      // Reopened after finishing in the period: DONE status gone, completedAt cleared by the service
      await f.task(p, { status: "IN_PROGRESS", completedAt: null });
      // Finished in the previous period, reopened and finished again in the period
      await f.task(p, done("2026-08-01T00:00:00Z", { createdAt: new Date("2026-05-01T00:00:00Z") }));
      const r = await f.report();
      assert.equal(r.totals.tasksCompleted, 1);
      assert.equal(r.totals.tasksCompletedPrevious, 0);
    }));

  test("weekly buckets: edges land in the right bucket, outside the period is excluded", () =>
    withFixture(async (f) => {
      const p = await f.program();
      await f.task(p, { createdAt: new Date("2026-06-30T23:59:59Z") }); // previous period
      await f.task(p, { createdAt: new Date("2026-07-05T23:59:59Z") }); // Sunday: first (partial) bucket
      await f.task(p, { createdAt: new Date("2026-07-06T00:00:00Z") }); // Monday: second bucket
      await f.task(p, { createdAt: new Date("2026-09-29T23:59:59Z") }); // last instant: last bucket
      await f.task(p, { createdAt: new Date("2026-09-30T00:00:00Z") }); // after the period
      await f.task(p, done("2026-07-06T00:00:00Z")); // created 07-02 (first bucket), completed in the second

      const r = await f.report();
      assert.deepEqual(r.trend[0], { start: "2026-07-01", end: "2026-07-05", created: 2, completed: 0 });
      assert.deepEqual(r.trend[1], { start: "2026-07-06", end: "2026-07-12", created: 1, completed: 1 });
      assert.deepEqual(r.trend.at(-1), { start: "2026-09-28", end: "2026-09-29", created: 1, completed: 0 });
      assert.equal(r.totals.tasksCreated, 4);
      assert.equal(r.totals.tasksCreatedPrevious, 1);
      assertInvariants(r);
    }));

  test("monthly buckets split at the UTC month boundary", () =>
    withFixture(async (f) => {
      const p = await f.program({ createdAt: new Date("2025-01-01T00:00:00Z") });
      await f.task(p, { createdAt: new Date("2026-01-31T23:59:59Z") });
      await f.task(p, { createdAt: new Date("2026-02-01T00:00:00Z") });
      const r = await f.report({ from: "2025-10-01", to: "2026-09-30" });
      assert.equal(r.period.granularity, "month");
      assert.equal(r.trend.length, 12);
      assert.deepEqual(r.trend[3], { start: "2026-01-01", end: "2026-01-31", created: 1, completed: 0 });
      assert.deepEqual(r.trend[4], { start: "2026-02-01", end: "2026-02-28", created: 1, completed: 0 });
      assertInvariants(r);
    }));

  test("owner teams: deleted or missing team → ownerTeam null and one null row, listed last", () =>
    withFixture(async (f) => {
      const alpha = await f.team("alpha");
      const beta = await f.team("Beta");
      const gone = await f.team("Gone", false);
      await f.program({ ownerTeamId: beta });
      await f.program({ ownerTeamId: alpha });
      const deletedTeamProgram = await f.program({ ownerTeamId: gone });
      const noTeamProgram = await f.program({ ownerTeamId: null });

      const r = await f.report();
      assert.deepEqual(
        r.teams.map((t) => [t.teamId, t.programs]),
        [[alpha, 1], [beta, 1], [null, 2]],
      );
      assert.equal(r.teams[2]!.name, null);
      for (const id of [deletedTeamProgram, noTeamProgram]) {
        assert.equal(r.programs.find((p) => p.id === id)!.ownerTeam, null);
      }
      assertInvariants(r);
    }));

  test("programs are ordered atRisk first, then overdue desc, then name ignoring case", () =>
    withFixture(async (f) => {
      const zeta = await f.program({ name: "Zeta", endDate: "2026-10-01" }); // at risk
      const alpha = await f.program({ name: "Alpha" });
      await f.task(alpha, { dueDate: "2026-09-01" });
      await f.task(alpha, { dueDate: "2026-09-02" });
      const beta = await f.program({ name: "beta" });
      // Past endDate but COMPLETED: not at risk
      const gamma = await f.program({ name: "Gamma", endDate: "2026-08-01", status: "COMPLETED", completedAt: new Date("2026-09-01T00:00:00Z") });

      const r = await f.report();
      assert.deepEqual(r.programs.map((p) => p.id), [zeta, alpha, beta, gamma]);
      assert.equal(r.totals.programsAtRisk, 1);
      assert.equal(r.totals.overdueTasks, 2);
      assertInvariants(r);
    }));
});

describe("programs completion checks", () => {
  test("the DB rejects a COMPLETED program without completedAt, and completedAt on an open one", () =>
    withFixture(async (f) => {
      for (const values of [{ status: "COMPLETED" as const }, { status: "ACTIVE" as const, completedAt: new Date() }]) {
        await assert.rejects(
          f.tx.transaction((sp) => sp.insert(programs).values({ key: `R${randomUUID().slice(0, 8)}`, name: "x", ...values })),
          (err: unknown) => (err as { cause?: { code?: string } }).cause?.code === "23514",
        );
      }
    }));
});
