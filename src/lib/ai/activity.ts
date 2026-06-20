export const cendroAiActivityLabels = {
  get_workspace_context: "Checking workspace context",
  list_tasks: "Checking visible tasks",
  get_task_detail: "Reading task details",
  list_assignable_users: "Checking assignable people",
  create_one_time_task: "Creating a one-time task",
  create_jd_task: "Creating a recurring task",
  complete_task: "Completing the task",
  add_task_comment: "Adding a task comment",
  search_sops: "Reading matching SOPs",
  get_sop: "Reading an SOP",
  create_sop: "Creating an SOP",
  list_people_in_scope: "Checking people in scope",
  get_analytics_summary: "Checking analytics",
  get_performance_summary: "Checking performance",
  web_search: "Searching the web",
  web_fetch: "Reading a web page",
} as const;

export type CendroAiToolName = keyof typeof cendroAiActivityLabels;

export function safeActivityLabel(toolName: string) {
  return cendroAiActivityLabels[toolName as CendroAiToolName] ?? "Preparing the answer";
}
