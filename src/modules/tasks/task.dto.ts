import type { TaskView } from "./task.repository";
import type { TaskSummary } from "./taskDependency.repository";

// Public shape of a task (matches taskSchema in task.docs.ts).
// status_before_dependent is internal and never returned.
export function toTaskDto({ task, assignee, reporter, parent, isDependent }: TaskView) {
  return {
    id: task.id,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    isActive: task.isActive,
    programId: task.programId,
    boardId: task.boardId,
    parent,
    key: task.key,
    number: task.number,
    title: task.title,
    description: task.description,
    type: task.type,
    status: task.status,
    priority: task.priority,
    assignee,
    reporter,
    startDate: task.startDate,
    dueDate: task.dueDate,
    estimateMinutes: task.estimateMinutes,
    labels: task.labels,
    completedAt: task.completedAt,
    isDependent,
  };
}

export interface TaskDetail {
  view: TaskView;
  dependsOn: TaskSummary[];
  blocks: TaskSummary[];
}

// Single-task responses: the task plus both sides of its dependency links
export function toTaskDetailDto({ view, dependsOn, blocks }: TaskDetail) {
  return { ...toTaskDto(view), dependsOn, blocks };
}

export type TaskDto = ReturnType<typeof toTaskDto>;
