import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { and, eq, isNotNull } from "drizzle-orm";
import { db, pool, type Transaction } from "../../db";
import { boards, employees, programs, tasks, teams, type NewBoard, type NewProgram, type NewTask } from "../../db/schema";
import { getOverviewReport, type OverviewReport } from "./report.service";
import type { ReportScope } from "./report.validation";

// Runs against DATABASE_URL. Every test works in a transaction that is always rolled back,
// and first hides the existing programs, boards and board tasks inside it, so it sees only its
// own fixtures. See "Testing notes" in .claude/specs/09-overview-report.md and 10-boards.md

const NOW = new Date("2026-10-20T12:00:00Z"); // asOf 2026-10-20, after the period below
// 91 days (weekly); previous period 2026-04-01 .. 2026-06-30
const PERIOD = { from: "2026-07-01", to: "2026-09-29" };

class Rollback extends Error {}

interface Fixture {
  tx: Transaction;
  program(values?: Partial<NewProgram>): Promise<string>;
  board(values?: Partial<NewBoard>): Promise<string>;
  // `parentId` is a program or board id from this fixture
  task(parentId: string, values?: Partial<NewTask>): Promise<string>;
  team(name: string, isActive?: boolean): Promise<string>;
  report(query?: { from: string; to: string; scope?: ReportScope }): Promise<OverviewReport>;
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.update(programs).set({ isActive: false }).where(eq(programs.isActive, true));
      // Board tasks count even on a deleted board, so hide the tasks themselves
      await tx.update(tasks).set({ isActive: false }).where(and(isNotNull(tasks.boardId), eq(tasks.isActive, true)));
      await tx.update(boards).set({ isActive: false }).where(eq(boards.isActive, true));
      const [reporter] = await tx
        .insert(employees)
        .values({ emailId: `report-test-${randomUUID()}@example.test`, name: "Report Tester" })
        .returning();
      const taskNumbers = new Map<string, number>();
      const programKeys = new Map<string, string>();
      const boardKeys = new Map<string, string>();

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
        async board(values = {}) {
          const key = `B${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
          const [row] = await tx.insert(boards).values({ key, name: key, ...values }).returning();
          boardKeys.set(row!.id, key);
          return row!.id;
        },
        async task(parentId, values = {}) {
          const number = (taskNumbers.get(parentId) ?? 0) + 1;
          taskNumbers.set(parentId, number);
          const onBoard = boardKeys.has(parentId);
          const [row] = await tx
            .insert(tasks)
            .values({
              ...(onBoard ? { boardId: parentId } : { programId: parentId }),
              number,
              key: `${(onBoard ? boardKeys : programKeys).get(parentId)}-${number}`,
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

// The totals the specs say always add up. `onDeletedBoards`: open/overdue tasks on deleted
// boards, which count in the totals but have no row.
function assertInvariants(r: OverviewReport, onDeletedBoards = { open: 0, overdue: 0 }): void {
  assert.equal(sum(Object.values(r.programsByStatus)), r.totals.programs);
  assert.equal(r.programs.length, r.totals.programs);
  assert.equal(r.programs.filter((p) => p.atRisk).length, r.totals.programsAtRisk);
  assert.equal(sum(Object.values(r.openTasksByPriority)), r.totals.openTasks);
  const rows = [...r.programs, ...r.boards];
  assert.equal(sum(rows.map((row) => row.openTasks)) + onDeletedBoards.open, r.totals.openTasks);
  assert.equal(sum(rows.map((row) => row.overdueTasks)) + onDeletedBoards.overdue, r.totals.overdueTasks);
  assert.equal(sum(r.teams.map((t) => t.openTasks)), sum(r.programs.map((p) => p.openTasks)));
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
      assert.deepEqual([r.teams, r.programs, r.boards], [[], [], []]);
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

describe("getOverviewReport scope (spec 10)", () => {
  // A program with two tasks; boards with live, late, deleted and post-period tasks; an empty board;
  // and a deleted board whose tasks still count
  async function seed(f: Fixture) {
    const p = await f.program();
    await f.task(p); // open
    await f.task(p, done("2026-07-10T00:00:00Z")); // completed in the period, no due date

    const beta = await f.board({ name: "beta" });
    await f.task(beta, { dueDate: "2026-09-01" }); // open, overdue
    await f.task(beta, done("2026-07-10T00:00:00Z", { dueDate: "2026-07-20" })); // on time
    await f.task(beta, { createdAt: new Date("2026-10-01T00:00:00Z") }); // created after `to`, open now
    await f.task(beta, { isActive: false }); // deleted task
    const alpha = await f.board({ name: "Alpha" });
    await f.task(alpha, { priority: "HIGH" }); // open
    await f.board({ name: "Empty" }); // no tasks: no row

    const gone = await f.board({ name: "Gone", isActive: false });
    await f.task(gone, { dueDate: "2026-09-01", priority: "LOW" }); // open, overdue
    await f.task(gone, done("2026-07-15T00:00:00Z"));
    return { p, beta, alpha };
  }

  const onGone = { open: 1, overdue: 1 };

  test("all (the default): program and board tasks together; deleted boards' tasks count without a row", () =>
    withFixture(async (f) => {
      const { p, beta, alpha } = await seed(f);
      const r = await f.report();
      assert.deepEqual(r.totals, {
        programs: 1,
        programsCompleted: 0,
        programsAtRisk: 0,
        tasksCreated: 7,
        tasksCreatedPrevious: 0,
        tasksCompleted: 3,
        tasksCompletedPrevious: 0,
        tasksCompletedWithDueDate: 1,
        tasksCompletedOnTime: 1,
        openTasks: 5,
        overdueTasks: 2,
      });
      // The beta task created after `to` is open now but wasn't live in the period
      assert.deepEqual(r.tasksByStatus, { DISCUSSION: 4, ON_HOLD: 0, IN_PROGRESS: 0, DONE: 3, DEPENDENT: 0 });
      assert.deepEqual(r.openTasksByPriority, { HIGHEST: 0, HIGH: 1, MEDIUM: 3, LOW: 1, LOWEST: 0 });
      assert.deepEqual(r.programs.map((row) => row.id), [p]);
      assert.deepEqual(
        r.boards.map(({ id, name, ...counts }) => ({ id, ...counts })),
        [
          { id: beta, key: r.boards[0]!.key, tasksTotal: 3, tasksDone: 1, tasksCompletedInPeriod: 1, openTasks: 2, overdueTasks: 1 },
          { id: alpha, key: r.boards[1]!.key, tasksTotal: 1, tasksDone: 0, tasksCompletedInPeriod: 0, openTasks: 1, overdueTasks: 0 },
        ],
      );
      assertInvariants(r, onGone);
    }));

  test("programs: board tasks left out and boards empty", () =>
    withFixture(async (f) => {
      const { p } = await seed(f);
      const r = await f.report({ ...PERIOD, scope: "programs" });
      assert.equal(r.totals.tasksCreated, 2);
      assert.equal(r.totals.tasksCompleted, 1);
      assert.equal(r.totals.tasksCompletedWithDueDate, 0);
      assert.equal(r.totals.openTasks, 1);
      assert.equal(r.totals.overdueTasks, 0);
      assert.deepEqual(r.tasksByStatus, { DISCUSSION: 1, ON_HOLD: 0, IN_PROGRESS: 0, DONE: 1, DEPENDENT: 0 });
      assert.deepEqual(r.programs.map((row) => row.id), [p]);
      assert.deepEqual(r.boards, []);
      assertInvariants(r);
    }));

  test("boards: program tasks left out, program-only fields zero/empty", () =>
    withFixture(async (f) => {
      const { beta, alpha } = await seed(f);
      const r = await f.report({ ...PERIOD, scope: "boards" });
      assert.deepEqual(
        [r.totals.programs, r.totals.programsCompleted, r.totals.programsAtRisk],
        [0, 0, 0],
      );
      assert.deepEqual(r.programsByStatus, { PLANNED: 0, ACTIVE: 0, ON_HOLD: 0, COMPLETED: 0, CANCELLED: 0 });
      assert.deepEqual([r.teams, r.programs], [[], []]);
      assert.equal(r.totals.tasksCreated, 5);
      assert.equal(r.totals.tasksCompleted, 2);
      assert.equal(r.totals.tasksCompletedOnTime, 1);
      assert.equal(r.totals.openTasks, 4);
      assert.equal(r.totals.overdueTasks, 2);
      assert.deepEqual(r.boards.map((row) => row.id), [beta, alpha]);
      assertInvariants(r, onGone);
    }));

  test("boards are ordered by overdue desc, then name ignoring case", () =>
    withFixture(async (f) => {
      const zeta = await f.board({ name: "Zeta" });
      await f.task(zeta, { dueDate: "2026-09-01" });
      const beta = await f.board({ name: "Beta" });
      await f.task(beta);
      const alpha = await f.board({ name: "alpha" });
      await f.task(alpha);
      const r = await f.report();
      assert.deepEqual(r.boards.map((row) => row.id), [zeta, alpha, beta]);
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
