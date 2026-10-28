import { z } from "zod";
import { taskPriority, taskStatus, taskType } from "../../db/schema";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../../db/repository";
import { boardIdParamSchema } from "../boards/board.validation";
import { programIdParamSchema } from "../programs/program.validation";
import { boardParent, programParent, type TaskParent } from "./task.parent";

// These schemas validate requests at runtime and also generate the OpenAPI docs
// (see task.docs.ts), so keep the `.meta` descriptions accurate.

export const MAX_DEPENDENCIES = 50;
export const MAX_LABELS = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_KEY_RE = /^[A-Za-z][A-Za-z0-9]{1,9}-\d+$/;
const LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,49}$/;

export const isUuid = (value: string) => UUID_RE.test(value);

export const taskStatusSchema = z.enum(taskStatus.enumValues).meta({
  id: "TaskStatus",
  description:
    "DISCUSSION, ON_HOLD, IN_PROGRESS and DONE are set by clients. DEPENDENT is set **automatically**: a task with an unfinished " +
    "blocker (a task it depends on that isn't DONE) becomes DEPENDENT, and returns to its previous status when its last open blocker " +
    "is done or removed. A DEPENDENT task's status can't be changed by hand (409 `TASK_BLOCKED`). DONE tasks never become " +
    "DEPENDENT; reopening a DONE task that has open blockers makes it DEPENDENT and remembers the requested status.",
  example: "IN_PROGRESS",
});

// Statuses a client may set; DEPENDENT is managed by syncDependentStatus
export const settableStatusSchema = z
  .enum(["DISCUSSION", "ON_HOLD", "IN_PROGRESS", "DONE"], {
    error: (iss) =>
      iss.input === "DEPENDENT" ? "DEPENDENT is set automatically from the task's dependencies" : undefined,
  })
  .meta({
    description: "DISCUSSION, ON_HOLD, IN_PROGRESS or DONE. DEPENDENT is rejected: it is set automatically.",
    example: "IN_PROGRESS",
  });

export const taskPrioritySchema = z
  .enum(taskPriority.enumValues)
  .meta({ id: "TaskPriority", description: "LOWEST < LOW < MEDIUM < HIGH < HIGHEST", example: "HIGH" });

export const taskTypeSchema = z.enum(taskType.enumValues).meta({
  id: "TaskType",
  description:
    "PRE: prerequisite work before the main work starts. TASK: the main work (default). " +
    "POST: follow-up work after the main work is done. BUG: something broken to fix. ISSUE: a problem, risk or question to resolve. " +
    "The type is informational: it doesn't affect status, dependencies or the parent's status. " +
    "Sort order is PRE < TASK < POST < BUG < ISSUE.",
  example: "PRE",
});

const labelSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(LABEL_RE, "Labels are 1-50 characters of a-z, 0-9, '.', '_' or '-', starting with a letter or digit, with no spaces");

const labelsSchema = z
  .array(labelSchema)
  .max(MAX_LABELS)
  .transform((labels) => [...new Set(labels)])
  .meta({
    description:
      `Up to ${MAX_LABELS} labels. Each is trimmed and lowercased, then must be 1-50 characters of a-z, 0-9, '.', '_' or '-' ` +
      "starting with a letter or digit (no spaces). Duplicates are removed after normalising.",
    example: ["survey", "q4"],
  });

const dateSchema = z.iso.date().nullable();

const taskFields = {
  title: z.string().trim().min(1).max(255).meta({ description: "The task heading. Trimmed; 1-255 characters", example: "Draft survey questions" }),
  description: z.string().max(20_000).nullable().meta({
    description: "Plain text or Markdown, stored as-is; at most 20,000 characters; null clears it",
    example: "Cover pricing, channels and brand recall.",
  }),
  type: taskTypeSchema,
  status: settableStatusSchema,
  priority: taskPrioritySchema,
  assigneeId: z.uuid().nullable().meta({
    description: "Active employee to assign; null unassigns",
    example: "baac08e5-eaef-46f0-ac9e-f8b7266c71e0",
  }),
  startDate: dateSchema.meta({ description: "YYYY-MM-DD, or null", example: "2026-10-20" }),
  dueDate: dateSchema.meta({
    description: "YYYY-MM-DD, or null. Must be on or after startDate. Past dates are allowed.",
    example: "2026-10-31",
  }),
  estimateMinutes: z.number().int().min(1).max(525_600).nullable().meta({
    description: "Original estimate in minutes, 1-525600 (one year), or null",
    example: 480,
  }),
  labels: labelsSchema,
};

export const createTaskSchema = z
  .object({
    title: taskFields.title,
    description: taskFields.description.optional(),
    type: taskFields.type.default("TASK").meta({ description: "Defaults to TASK" }),
    status: taskFields.status.default("DISCUSSION").meta({ description: "Defaults to DISCUSSION. DEPENDENT is rejected." }),
    priority: taskFields.priority.default("MEDIUM").meta({ description: "Defaults to MEDIUM" }),
    assigneeId: taskFields.assigneeId.optional(),
    startDate: taskFields.startDate.optional(),
    dueDate: taskFields.dueDate.optional(),
    estimateMinutes: taskFields.estimateMinutes.optional(),
    labels: taskFields.labels.default([]),
    dependsOn: z
      .array(z.uuid())
      .max(MAX_DEPENDENCIES)
      .refine((ids) => new Set(ids).size === ids.length, "dependsOn must not contain duplicates")
      .default([])
      .meta({
        description: `Ids of tasks with the same parent (program or board) that block this one; unique, at most ${MAX_DEPENDENCIES}`,
        example: ["0e6c1f2a-4b8d-4c3e-9f7a-1d2b3c4d5e6f"],
      }),
  })
  .meta({
    id: "CreateTaskRequest",
    description: "The reporter is the signed-in employee; a `reporterId` in the body is ignored.",
  });

export const updateTaskSchema = z
  .strictObject(
    {
      title: taskFields.title.optional(),
      description: taskFields.description.optional(),
      type: taskFields.type.optional(),
      status: taskFields.status.optional(),
      priority: taskFields.priority.optional(),
      assigneeId: taskFields.assigneeId.optional(),
      startDate: taskFields.startDate.optional(),
      dueDate: taskFields.dueDate.optional(),
      estimateMinutes: taskFields.estimateMinutes.optional(),
      labels: taskFields.labels.optional().meta({ description: "Replaces the whole label list" }),
    },
    {
      error: (iss) => {
        if (iss.code !== "unrecognized_keys") return undefined;
        if (iss.keys.includes("dependsOn")) return "Use the dependency endpoints to change dependencies";
        if (iss.keys.includes("programId") || iss.keys.includes("boardId")) return "A task's parent can't be changed";
        return undefined;
      },
    },
  )
  .refine((body) => Object.keys(body).length > 0, "At least one field is required")
  .meta({
    id: "UpdateTaskRequest",
    description:
      "Send at least one field. Nullable fields accept null to clear them. Unknown fields are rejected, including `dependsOn` " +
      "and `programId`/`boardId` (a task's parent is fixed at creation).",
  });

export const addDependencySchema = z
  .object({
    dependsOnTaskId: z.uuid().meta({
      description: "Id of the blocking task (same program or board)",
      example: "0e6c1f2a-4b8d-4c3e-9f7a-1d2b3c4d5e6f",
    }),
  })
  .meta({ id: "AddDependencyRequest" });

// "a,b , c" -> ["a", "b", "c"]
const csv = z.string().transform((s) => s.split(",").map((part) => part.trim()).filter(Boolean));

export const listTasksQuerySchema = z
  .object({
    status: csv.pipe(z.array(taskStatusSchema).min(1)).optional().meta({
      description: "Comma-separated task statuses; matches any (e.g. `IN_PROGRESS,DEPENDENT`)",
      example: "IN_PROGRESS,DEPENDENT",
    }),
    priority: csv.pipe(z.array(taskPrioritySchema).min(1)).optional().meta({
      description: "Comma-separated priorities; matches any",
      example: "HIGH,HIGHEST",
    }),
    type: csv.pipe(z.array(taskTypeSchema).min(1)).optional().meta({
      description: "Comma-separated task types; matches any (e.g. `PRE,POST`)",
      example: "PRE,POST",
    }),
    assigneeId: z.union([z.literal("me"), z.uuid()]).optional().meta({
      description: "Employee UUID, or `me` for the signed-in employee. Can't be combined with `unassigned`.",
      example: "me",
    }),
    unassigned: z.stringbool().optional().meta({
      description: "true: only tasks with no assignee. Can't be combined with `assigneeId`.",
      example: "false",
    }),
    reporterId: z.union([z.literal("me"), z.uuid()]).optional().meta({
      description: "Employee UUID, or `me` for the signed-in employee",
      example: "me",
    }),
    label: csv.pipe(z.array(labelSchema).min(1)).optional().meta({
      description: "Comma-separated labels (normalised like `labels`); matches tasks with any of them",
      example: "survey,q4",
    }),
    dueFrom: z.iso.date().optional().meta({ description: "Due on or after this date (YYYY-MM-DD)", example: "2026-10-01" }),
    dueTo: z.iso.date().optional().meta({ description: "Due on or before this date (YYYY-MM-DD)", example: "2026-10-31" }),
    createdFrom: z.iso.date().optional().meta({
      description: "Created on or after this date (YYYY-MM-DD, compared with the UTC date of `createdAt`)",
      example: "2026-10-22",
    }),
    createdTo: z.iso.date().optional().meta({
      description: "Created on or before this date (YYYY-MM-DD, compared with the UTC date of `createdAt`)",
      example: "2026-10-28",
    }),
    isDependent: z.stringbool().optional().meta({
      description: "Filter on the computed `isDependent` flag (the task has at least one dependency)",
      example: "true",
    }),
    q: z.string().trim().min(1).max(100).optional().meta({
      description: "Case-insensitive substring of the title, or an exact task key (case-insensitive); 1-100 characters",
      example: "survey",
    }),
    sort: z.enum(["number", "createdAt", "updatedAt", "dueDate", "priority", "type"]).default("number").meta({
      description:
        "Sort field. `type` sorts PRE < TASK < POST < BUG < ISSUE. Tasks without a due date sort last; `number` breaks ties.",
      example: "number",
    }),
    order: z.enum(["asc", "desc"]).default("desc").meta({ description: "Sort direction", example: "desc" }),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE).meta({
      description: `Page size, 1-${MAX_PAGE_SIZE}`,
      example: 20,
    }),
    offset: z.coerce.number().int().min(0).default(0).meta({
      description: "Number of rows to skip",
      nullable: false,
      example: 0,
    }),
  })
  .superRefine((query, ctx) => {
    if (query.assigneeId !== undefined && query.unassigned !== undefined) {
      ctx.addIssue({ code: "custom", path: ["unassigned"], message: "Use either assigneeId or unassigned, not both" });
    }
    if (query.dueFrom && query.dueTo && query.dueFrom > query.dueTo) {
      ctx.addIssue({ code: "custom", path: ["dueTo"], message: "dueTo must be on or after dueFrom" });
    }
    if (query.createdFrom && query.createdTo && query.createdFrom > query.createdTo) {
      ctx.addIssue({ code: "custom", path: ["createdTo"], message: "createdTo must be on or after createdFrom" });
    }
  });

// /tasks/:taskRef: any reachable task, whatever its parent
export const taskRefOnlyParamSchema = z.object({
  taskRef: z
    .string()
    .refine((ref) => isUuid(ref) || TASK_KEY_RE.test(ref), "Must be a task UUID or a task key like MKT-7")
    .meta({ description: "Task UUID, or task key such as `MKT-7` (case-insensitive)", example: "MKT-7" }),
});

// /programs/:programId/tasks/:taskRef: the task must be in that program
export const taskRefParamSchema = programIdParamSchema.extend(taskRefOnlyParamSchema.shape);

const dependsOnTaskIdShape = {
  dependsOnTaskId: z.uuid().meta({ description: "Id of the blocking task to unlink", example: "0e6c1f2a-4b8d-4c3e-9f7a-1d2b3c4d5e6f" }),
};

export const dependencyParamSchema = taskRefParamSchema.extend(dependsOnTaskIdShape);
export const taskRefDependencyParamSchema = taskRefOnlyParamSchema.extend(dependsOnTaskIdShape);

// How a single-task route finds its task: within a program (/programs/:programId/tasks/:taskRef…),
// or by UUID or key alone (/tasks/:taskRef…). See "Reachable task" in .claude/specs/10-boards.md
export type TaskLocator = { programId: string; taskRef: string } | { taskRef: string };

// The same handlers serve both mounts; the program one has :programId in its params
export function parseTaskLocator(params: Record<string, unknown>): TaskLocator {
  return "programId" in params ? taskRefParamSchema.parse(params) : taskRefOnlyParamSchema.parse(params);
}

// The parent of a task list or create route: /programs/:programId/tasks or /boards/:boardId/tasks
export function parseTaskParent(params: Record<string, unknown>): TaskParent {
  return "boardId" in params
    ? boardParent(boardIdParamSchema.parse(params).boardId)
    : programParent(programIdParamSchema.parse(params).programId);
}

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
export type SettableTaskStatus = z.infer<typeof settableStatusSchema>;
