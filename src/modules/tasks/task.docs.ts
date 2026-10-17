import { z } from "zod";
import {
  authNote,
  bearerSecurity,
  employeeSummarySchema,
  errorResponseSchema,
  forbiddenResponse,
  internalServerErrorResponse,
  jsonResponse,
  paginationMetaSchema,
  registry,
  unauthorizedResponse,
  validationErrorResponseSchema,
} from "../../docs/registry";
import { programIdParamSchema } from "../programs/program.validation";
import { programNotFoundResponse } from "../programs/program.docs";
import {
  addDependencySchema,
  createTaskSchema,
  dependencyParamSchema,
  listTasksQuerySchema,
  taskPrioritySchema,
  taskRefParamSchema,
  taskStatusSchema,
  updateTaskSchema,
} from "./task.validation";

const ids = {
  program: "5b1f6a3e-8c1d-4f8e-9a51-2a7c3d9e0b14",
  task: "7d2e9b40-1c3a-4e5f-8a6b-9c0d1e2f3a4b",
  blocker: "0e6c1f2a-4b8d-4c3e-9f7a-1d2b3c4d5e6f",
  dependent: "3f4a5b6c-7d8e-4f90-a1b2-c3d4e5f6a7b8",
};

const exampleBlockerSummary = { id: ids.blocker, key: "MKT-3", title: "Finalise sample", status: "IN_PROGRESS" };

export const exampleTask = {
  id: ids.task,
  createdAt: "2026-10-17T10:00:00.000Z",
  updatedAt: "2026-10-17T10:00:00.000Z",
  isActive: true,
  programId: ids.program,
  key: "MKT-7",
  number: 7,
  title: "Draft survey questions",
  description: "Cover pricing, channels and brand recall.",
  status: "DEPENDENT",
  priority: "HIGH",
  assignee: { id: "baac08e5-eaef-46f0-ac9e-f8b7266c71e0", name: "Jane Doe", emailId: "jane.doe@saajha.org" },
  reporter: { id: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f", name: "Ravi Kumar", emailId: "ravi.kumar@saajha.org" },
  startDate: "2026-10-20",
  dueDate: "2026-10-31",
  estimateMinutes: 480,
  labels: ["survey", "q4"],
  completedAt: null,
  isDependent: true,
};

const exampleTaskDetail = {
  ...exampleTask,
  dependsOn: [exampleBlockerSummary],
  blocks: [{ id: ids.dependent, key: "MKT-9", title: "Run survey", status: "DEPENDENT" }],
};

export const taskSummarySchema = registry.register(
  "TaskSummary",
  z
    .object({ id: z.uuid(), key: z.string(), title: z.string(), status: taskStatusSchema })
    .meta({ example: exampleBlockerSummary }),
);

// Mirrors toTaskDto in task.dto.ts (status_before_dependent is internal and not returned)
const taskShape = {
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  isActive: z.boolean(),
  programId: z.uuid(),
  key: z.string().meta({ description: "Human key `<program key>-<number>`, e.g. MKT-7. Never reused." }),
  number: z.number().int().meta({ description: "Per-program sequence number" }),
  title: z.string().meta({ description: "The task heading" }),
  description: z.string().nullable(),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
  assignee: employeeSummarySchema.nullable().meta({ description: "null when unassigned" }),
  reporter: employeeSummarySchema.meta({ description: "The employee who created the task" }),
  startDate: z.iso.date().nullable(),
  dueDate: z.iso.date().nullable(),
  estimateMinutes: z.number().int().nullable().meta({ description: "Original estimate in minutes" }),
  labels: z.array(z.string()),
  completedAt: z.iso.datetime().nullable().meta({ description: "When the task last moved to DONE; null when not DONE" }),
  isDependent: z.boolean().meta({
    description:
      "Computed, not stored: true when the task has at least one dependency (open or DONE). An open blocker is what `status: DEPENDENT` reflects.",
  }),
};

export const taskSchema = registry.register("Task", z.object(taskShape).meta({ example: exampleTask }));

export const taskDetailSchema = registry.register(
  "TaskDetail",
  z
    .object({
      ...taskShape,
      dependsOn: z.array(taskSummarySchema).meta({ description: "Tasks this task is blocked by, ordered by number" }),
      blocks: z.array(taskSummarySchema).meta({ description: "Tasks blocked by this task, ordered by number" }),
    })
    .meta({ example: exampleTaskDetail }),
);

const taskDetailEnvelope = registry.register("TaskDetailResponse", z.object({ data: taskDetailSchema }));
const taskListSchema = registry.register(
  "TaskListResponse",
  z.object({ data: z.array(taskSchema), meta: paginationMetaSchema }),
);

// ---- Reusable responses ----

const error = (description: string, example: { error: string; code?: string; details?: unknown }) =>
  jsonResponse(description, errorResponseSchema, example);

const examplesResponse = (
  description: string,
  examples: Record<string, { error: string; code?: string; details?: unknown }>,
) => ({
  description,
  content: {
    "application/json": {
      schema: errorResponseSchema,
      examples: Object.fromEntries(Object.entries(examples).map(([name, value]) => [name, { value }])),
    },
  },
});

const notFound = examplesResponse(
  "The program is unknown or soft-deleted, or there is no active task with this id/key in the program",
  {
    program: { error: "Program not found" },
    task: { error: "Task not found" },
  },
);

const taskBlockedExample = {
  error: "Task is blocked by unfinished dependencies",
  code: "TASK_BLOCKED",
  details: { blockers: [exampleBlockerSummary] },
};

const assigneeNotFound = { error: "Assignee not found or inactive", code: "ASSIGNEE_NOT_FOUND" };
const invalidDateRange = { error: "dueDate must be on or after startDate", code: "INVALID_DATE_RANGE" };
const dependencyNotFound = { error: `Dependency task ${ids.blocker} not found`, code: "DEPENDENCY_TASK_NOT_FOUND" };
const dependencyOtherProgram = { error: "Task OPS-2 belongs to another program", code: "DEPENDENCY_OTHER_PROGRAM" };

const validation400 = (description: string, examples: Record<string, unknown>) => ({
  description,
  content: {
    "application/json": {
      schema: z.union([validationErrorResponseSchema, errorResponseSchema]),
      examples: Object.fromEntries(Object.entries(examples).map(([name, value]) => [name, { value }])),
    },
  },
});

const STATUS_RULES =
  "**Status rules:** `DEPENDENT` can't be sent (400); it is set automatically while the task has an unfinished blocker, " +
  "and the previous status comes back when the last open blocker is done or removed. While a task is `DEPENDENT`, any `status` " +
  "change returns 409 `TASK_BLOCKED` with the open blockers in `details.blockers`. Moving to `DONE` sets `completedAt`; leaving `DONE` clears it. " +
  "Reopening a `DONE` task that has open blockers saves it as `DEPENDENT` and remembers the requested status. " +
  "When a task moves into or out of `DONE`, the tasks it blocks are re-evaluated.";

const BODY_HEADER = "**Headers:** `Content-Type: application/json` is required for the body to be parsed.";

// ---- Paths ----

registry.registerPath({
  method: "post",
  path: "/programs/{programId}/tasks",
  tags: ["Tasks"],
  summary: "Create a task",
  description:
    "Creates a task in the program and gives it the next key (`MKT-1`, `MKT-2`…; numbers are never reused). " +
    "The signed-in employee becomes the reporter. `dependsOn` links blockers in the same program; if any is unfinished the task " +
    "starts as `DEPENDENT`, and the requested status is restored once they are done.\n\n" +
    "Rules, in order: the program must be active (404); `assigneeId` must be an active employee (400 `ASSIGNEE_NOT_FOUND`); " +
    "`dueDate` on or after `startDate` (400 `INVALID_DATE_RANGE`); each `dependsOn` id an active task (400 `DEPENDENCY_TASK_NOT_FOUND`) " +
    "in this program (400 `DEPENDENCY_OTHER_PROGRAM`); `status: DONE` with an unfinished blocker is rejected (409 `TASK_BLOCKED`).\n\n" +
    `${BODY_HEADER}\n\n${authNote()}`,
  security: bearerSecurity,
  request: {
    params: programIdParamSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createTaskSchema,
          example: {
            title: "Draft survey questions",
            description: "Cover pricing, channels and brand recall.",
            status: "IN_PROGRESS",
            priority: "HIGH",
            assigneeId: "baac08e5-eaef-46f0-ac9e-f8b7266c71e0",
            startDate: "2026-10-20",
            dueDate: "2026-10-31",
            estimateMinutes: 480,
            labels: ["Survey", "q4"],
            dependsOn: [ids.blocker],
          },
        },
      },
    },
  },
  responses: {
    201: jsonResponse("Task created", taskDetailEnvelope, { data: { ...exampleTaskDetail, blocks: [] } }),
    400: validation400(
      "A field breaks its validation rule (listed in `details`), or a business rule failed (`code`)",
      {
        validation: {
          error: "Validation failed",
          details: [{ path: "status", message: "DEPENDENT is set automatically from the task's dependencies" }],
        },
        assigneeNotFound,
        invalidDateRange,
        dependencyNotFound,
        dependencyOtherProgram,
      },
    ),
    401: unauthorizedResponse,
    404: programNotFoundResponse,
    409: error("`TASK_BLOCKED`: `status: DONE` was requested while a task in `dependsOn` is not DONE", taskBlockedExample),
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/programs/{programId}/tasks",
  tags: ["Tasks"],
  summary: "List and filter tasks",
  description:
    "Returns the program's active tasks, one page at a time. Filters combine with AND; comma-separated values within one filter match any. " +
    "Default order is `number` descending (newest first). Tasks without a due date sort last; `number` breaks ties.\n\n" +
    authNote(),
  security: bearerSecurity,
  request: { params: programIdParamSchema, query: listTasksQuerySchema },
  responses: {
    200: jsonResponse("A page of tasks", taskListSchema, { data: [exampleTask], meta: { total: 1, limit: 20, offset: 0 } }),
    400: jsonResponse(
      "Invalid path or query parameter: unknown status/priority, bad UUID, bad date, `assigneeId` combined with `unassigned`, " +
        "`dueFrom` after `dueTo`, `limit` outside 1-100…",
      validationErrorResponseSchema,
      { error: "Validation failed", details: [{ path: "unassigned", message: "Use either assigneeId or unassigned, not both" }] },
    ),
    401: unauthorizedResponse,
    404: programNotFoundResponse,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/programs/{programId}/tasks/{taskRef}",
  tags: ["Tasks"],
  summary: "Get a task by id or key",
  description:
    "Returns one task with both sides of its dependency links (`dependsOn`, `blocks`). `taskRef` is the task UUID or its key " +
    `(case-insensitive, e.g. \`mkt-7\`). A key or UUID of a task in another program returns 404.\n\n${authNote()}`,
  security: bearerSecurity,
  request: { params: taskRefParamSchema },
  responses: {
    200: jsonResponse("The task", taskDetailEnvelope, { data: exampleTaskDetail }),
    400: jsonResponse("`programId` is not a UUID, or `taskRef` is neither a UUID nor a task key", validationErrorResponseSchema, {
      error: "Validation failed",
      details: [{ path: "taskRef", message: "Must be a task UUID or a task key like MKT-7" }],
    }),
    401: unauthorizedResponse,
    404: notFound,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "patch",
  path: "/programs/{programId}/tasks/{taskRef}",
  tags: ["Tasks"],
  summary: "Update a task",
  description:
    "Updates any subset of the task's fields; at least one is required. Nullable fields accept null to clear them, and `labels` replaces " +
    "the whole list. Dependencies change only through the dependency endpoints, so `dependsOn` is rejected.\n\n" +
    "Rules, in order: `assigneeId` must be an active employee (400 `ASSIGNEE_NOT_FOUND`); the **merged** `startDate`/`dueDate` must be in order " +
    "(400 `INVALID_DATE_RANGE`); then the status rules.\n\n" +
    `${STATUS_RULES}\n\n${BODY_HEADER}\n\n${authNote()}`,
  security: bearerSecurity,
  request: {
    params: taskRefParamSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: updateTaskSchema,
          example: { status: "DONE", labels: ["survey", "q4", "done"] },
        },
      },
    },
  },
  responses: {
    200: jsonResponse("The updated task", taskDetailEnvelope, {
      data: { ...exampleTaskDetail, status: "DONE", completedAt: "2026-10-30T16:20:00.000Z", dependsOn: [{ ...exampleBlockerSummary, status: "DONE" }] },
    }),
    400: validation400("Invalid params or body, or a business rule failed (`code`)", {
      validation: {
        error: "Validation failed",
        details: [{ path: "", message: "Use the dependency endpoints to change dependencies" }],
      },
      assigneeNotFound,
      invalidDateRange,
    }),
    401: unauthorizedResponse,
    404: notFound,
    409: error("`TASK_BLOCKED`: the task is DEPENDENT, so its status can't be changed until its blockers are done or removed", taskBlockedExample),
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "delete",
  path: "/programs/{programId}/tasks/{taskRef}",
  tags: ["Tasks"],
  summary: "Soft-delete a task",
  description:
    "Sets `isActive = false` and removes every dependency link on either side of the task. Tasks it blocked are re-evaluated, so a task " +
    "whose only open blocker this was leaves `DEPENDENT`. The task's number is not reused.\n\n" +
    "**Authentication:** required. Send `Authorization: Bearer <accessToken>` (from `POST /auth/google`, Google sign-in).\n\n" +
    "**Authorization / roles:** ADMIN or MANAGER, or the task's **reporter** (any role). Anyone else gets 403 `FORBIDDEN`.",
  security: bearerSecurity,
  request: { params: taskRefParamSchema },
  responses: {
    204: { description: "Task deleted" },
    400: jsonResponse("Invalid `programId` or `taskRef`", validationErrorResponseSchema, {
      error: "Validation failed",
      details: [{ path: "taskRef", message: "Must be a task UUID or a task key like MKT-7" }],
    }),
    401: unauthorizedResponse,
    403: forbiddenResponse,
    404: notFound,
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "post",
  path: "/programs/{programId}/tasks/{taskRef}/dependencies",
  tags: ["Tasks"],
  summary: "Add a blocker (task depends on another task)",
  description:
    "Records that the task is blocked by `dependsOnTaskId`. If the blocker isn't DONE, the task becomes `DEPENDENT` and its current status " +
    "is remembered.\n\n" +
    "Rules, in order: the blocker is an active task (400 `DEPENDENCY_TASK_NOT_FOUND`) in the same program (400 `DEPENDENCY_OTHER_PROGRAM`); " +
    "not the task itself (400 `SELF_DEPENDENCY`); not already linked (409 `DEPENDENCY_EXISTS`); the task has fewer than 50 dependencies " +
    "(400 `DEPENDENCY_LIMIT_REACHED`); the link doesn't create a cycle (409 `DEPENDENCY_CYCLE`); a DONE task can't get an unfinished blocker " +
    "(409 `TASK_DONE`).\n\n" +
    `${BODY_HEADER}\n\n${authNote()}`,
  security: bearerSecurity,
  request: {
    params: taskRefParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: addDependencySchema, example: { dependsOnTaskId: ids.blocker } } },
    },
  },
  responses: {
    201: jsonResponse("Dependency added; the dependent task with its (possibly new) status", taskDetailEnvelope, {
      data: exampleTaskDetail,
    }),
    400: validation400("Invalid params or body, or a dependency rule failed (`code`)", {
      validation: { error: "Validation failed", details: [{ path: "dependsOnTaskId", message: "Invalid UUID" }] },
      dependencyNotFound,
      dependencyOtherProgram,
      selfDependency: { error: "A task can't depend on itself", code: "SELF_DEPENDENCY" },
      limitReached: { error: "A task can have at most 50 dependencies", code: "DEPENDENCY_LIMIT_REACHED" },
    }),
    401: unauthorizedResponse,
    404: notFound,
    409: examplesResponse("The link already exists, would create a cycle, or would block a DONE task", {
      exists: { error: "MKT-7 already depends on MKT-3", code: "DEPENDENCY_EXISTS" },
      cycle: { error: "Adding this dependency would create a cycle", code: "DEPENDENCY_CYCLE" },
      taskDone: { error: "Reopen the task before adding an unfinished dependency", code: "TASK_DONE" },
    }),
    500: internalServerErrorResponse,
  },
});

registry.registerPath({
  method: "delete",
  path: "/programs/{programId}/tasks/{taskRef}/dependencies/{dependsOnTaskId}",
  tags: ["Tasks"],
  summary: "Remove a blocker",
  description:
    "Deletes the link. If that was the task's last open blocker, it leaves `DEPENDENT` and gets its previous status back. " +
    `Returns 200 with the task (not 204) because its status may have just changed.\n\n${authNote()}`,
  security: bearerSecurity,
  request: { params: dependencyParamSchema },
  responses: {
    200: jsonResponse("Dependency removed; the task with its (possibly restored) status", taskDetailEnvelope, {
      data: { ...exampleTaskDetail, status: "IN_PROGRESS", isDependent: false, dependsOn: [] },
    }),
    400: jsonResponse("Invalid `programId`, `taskRef` or `dependsOnTaskId`", validationErrorResponseSchema, {
      error: "Validation failed",
      details: [{ path: "dependsOnTaskId", message: "Invalid UUID" }],
    }),
    401: unauthorizedResponse,
    404: examplesResponse("Unknown program or task, or the task doesn't depend on `dependsOnTaskId`", {
      program: { error: "Program not found" },
      task: { error: "Task not found" },
      dependency: { error: "Dependency not found" },
    }),
    500: internalServerErrorResponse,
  },
});
