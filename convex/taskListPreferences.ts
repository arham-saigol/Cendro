import { ConvexError, v } from "convex/values";
import {
  isTaskListSortForTaskType,
  type TaskListSort,
  type TaskListTaskType,
} from "../src/lib/task-list-sort";

export const taskListTaskTypeValidator = v.union(v.literal("jd"), v.literal("one_time"));
export const taskListSortDirectionValidator = v.union(v.literal("asc"), v.literal("desc"));
export const taskListSortFieldValidator = v.union(
  v.literal("code"),
  v.literal("user"),
  v.literal("frequency"),
  v.literal("priority"),
  v.literal("dueDate"),
  v.literal("title"),
  v.literal("dateAssigned"),
  v.literal("quantity"),
);

export const taskListSortValidator = v.union(
  v.object({ mode: v.literal("default") }),
  v.object({ mode: v.literal("custom") }),
  v.object({
    mode: v.literal("field"),
    field: taskListSortFieldValidator,
    direction: taskListSortDirectionValidator,
  }),
);

export const taskListPreferenceValidator = v.union(
  v.object({
    companyId: v.id("companies"),
    membershipId: v.id("companyMemberships"),
    taskType: v.literal("jd"),
    sort: taskListSortValidator,
    customOrder: v.optional(v.array(v.id("jdTasks"))),
    orderFormat: v.optional(v.literal("vector")),
    revision: v.number(),
    updatedAt: v.number(),
  }),
  v.object({
    companyId: v.id("companies"),
    membershipId: v.id("companyMemberships"),
    taskType: v.literal("one_time"),
    sort: taskListSortValidator,
    customOrder: v.optional(v.array(v.id("oneTimeTasks"))),
    orderFormat: v.optional(v.literal("vector")),
    revision: v.number(),
    updatedAt: v.number(),
  }),
);

export const taskListOrderEntryValidator = v.union(
  v.object({
    companyId: v.id("companies"),
    membershipId: v.id("companyMemberships"),
    taskType: v.literal("jd"),
    taskId: v.id("jdTasks"),
    orderKey: v.string(),
    updatedAt: v.number(),
  }),
  v.object({
    companyId: v.id("companies"),
    membershipId: v.id("companyMemberships"),
    taskType: v.literal("one_time"),
    taskId: v.id("oneTimeTasks"),
    orderKey: v.string(),
    updatedAt: v.number(),
  }),
);

export const taskListPreferenceResultValidator = v.union(
  v.object({
    taskType: v.literal("jd"),
    sort: taskListSortValidator,
    customOrder: v.union(v.array(v.id("jdTasks")), v.null()),
    orderFormat: v.optional(v.literal("vector")),
    revision: v.number(),
    updatedAt: v.union(v.number(), v.null()),
  }),
  v.object({
    taskType: v.literal("one_time"),
    sort: taskListSortValidator,
    customOrder: v.union(v.array(v.id("oneTimeTasks")), v.null()),
    orderFormat: v.optional(v.literal("vector")),
    revision: v.number(),
    updatedAt: v.union(v.number(), v.null()),
  }),
);

export function assertTaskListSort(
  taskType: TaskListTaskType,
  sort: unknown,
): asserts sort is TaskListSort {
  if (!isTaskListSortForTaskType(taskType, sort)) {
    throw new ConvexError("This sort is not available for this task list.");
  }
}
