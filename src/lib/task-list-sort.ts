export const taskListTaskTypes = ["jd", "one_time"] as const;

export type TaskListTaskType = (typeof taskListTaskTypes)[number];
export type TaskListSortDirection = "asc" | "desc";
export type TaskListSortField =
  | "code"
  | "user"
  | "frequency"
  | "priority"
  | "dueDate"
  | "title"
  | "dateAssigned"
  | "quantity";

export type TaskListSort =
  | { mode: "default" }
  | { mode: "custom" }
  | { mode: "field"; field: TaskListSortField; direction: TaskListSortDirection };

const fieldsByTaskType: Record<TaskListTaskType, readonly TaskListSortField[]> = {
  jd: ["code", "user", "frequency", "title", "quantity"],
  one_time: ["code", "user", "priority", "dueDate", "title", "dateAssigned"],
};

const allFields = new Set<TaskListSortField>([
  "code",
  "user",
  "frequency",
  "priority",
  "dueDate",
  "title",
  "dateAssigned",
  "quantity",
]);

const fieldLabels: Record<TaskListSortField, string> = {
  code: "Code",
  user: "Assigned to",
  frequency: "Frequency",
  priority: "Priority",
  dueDate: "Due date",
  title: "Title",
  dateAssigned: "Date assigned",
  quantity: "Quantity",
};

export function taskListSortFields(taskType: TaskListTaskType) {
  return fieldsByTaskType[taskType];
}

export function taskListSortFieldLabel(field: TaskListSortField) {
  return fieldLabels[field];
}

export function defaultTaskListSort(taskType: TaskListTaskType): TaskListSort {
  void taskType;
  return { mode: "default" };
}

export function defaultTaskListSortField(taskType: TaskListTaskType): TaskListSortField {
  return taskType === "jd" ? "frequency" : "priority";
}

export function defaultTaskListSortDirection(taskType: TaskListTaskType): TaskListSortDirection {
  return taskType === "jd" ? "asc" : "desc";
}

export function initialTaskListSortDirection(field: TaskListSortField): TaskListSortDirection {
  return field === "priority" || field === "dateAssigned" ? "desc" : "asc";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTaskListSort(value: unknown): value is TaskListSort {
  if (!isRecord(value) || typeof value.mode !== "string") return false;
  if (value.mode === "default" || value.mode === "custom") return true;
  return (
    value.mode === "field" &&
    typeof value.field === "string" &&
    allFields.has(value.field as TaskListSortField) &&
    (value.direction === "asc" || value.direction === "desc")
  );
}

export function isTaskListSortForTaskType(
  taskType: TaskListTaskType,
  value: unknown,
): value is TaskListSort {
  return (
    isTaskListSort(value) &&
    (value.mode !== "field" || fieldsByTaskType[taskType].includes(value.field))
  );
}

export function taskListSortLabel(taskType: TaskListTaskType, sort: TaskListSort) {
  if (sort.mode === "default") return "Default";
  if (sort.mode === "custom") return "Custom";
  return `${taskListSortFieldLabel(sort.field)} (${sort.direction === "asc" ? "ascending" : "descending"})`;
}
