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

export const cendroAiCompletedActivityLabels = {
  get_workspace_context: "Checked workspace context",
  list_tasks: "Checked visible tasks",
  get_task_detail: "Read task details",
  list_assignable_users: "Checked assignable people",
  create_one_time_task: "Created a one-time task",
  create_jd_task: "Created a recurring task",
  complete_task: "Completed the task",
  add_task_comment: "Added a task comment",
  search_sops: "Read matching SOPs",
  get_sop: "Read an SOP",
  create_sop: "Created an SOP",
  list_people_in_scope: "Checked people in scope",
  get_analytics_summary: "Checked analytics",
  get_performance_summary: "Checked performance",
  web_search: "Searched the web",
  web_fetch: "Read a web page",
} as const satisfies Record<keyof typeof cendroAiActivityLabels, string>;

export type CendroAiToolName = keyof typeof cendroAiActivityLabels;

export function safeActivityLabel(toolName: string) {
  return cendroAiActivityLabels[toolName as CendroAiToolName] ?? "Preparing the answer";
}

export function safeCompletedActivityLabel(toolName: string) {
  return cendroAiCompletedActivityLabels[toolName as CendroAiToolName] ?? "Prepared the answer";
}
