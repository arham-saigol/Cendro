export const cendroAiActivityLabels = {
  get_workspace_context: "Checking workspace context",
  list_tasks: "Checking visible tasks",
  get_task: "Reading task details",
  list_people: "Checking workspace members",
  list_assignable_users: "Checking assignable people",
  create_task: "Creating a task",
  update_task: "Updating a task",
  set_task_status: "Updating task status",
  add_task_comment: "Adding a task comment",
  delete_task: "Deleting a task",
  list_sops: "Reading matching SOPs",
  get_sop: "Reading an SOP",
  list_sop_scope_targets: "Checking SOP scope targets",
  create_sop: "Creating an SOP",
  update_sop: "Updating an SOP",
  delete_sop: "Deleting an SOP",
  get_analytics_summary: "Checking analytics",
  get_performance_summary: "Checking performance",
  web_search: "Searching the web",
  web_fetch: "Reading a web page",
} as const;

export const cendroAiCompletedActivityLabels = {
  get_workspace_context: "Checked workspace context",
  list_tasks: "Checked visible tasks",
  get_task: "Read task details",
  list_people: "Checked workspace members",
  list_assignable_users: "Checked assignable people",
  create_task: "Created a task",
  update_task: "Updated a task",
  set_task_status: "Updated task status",
  add_task_comment: "Added a task comment",
  delete_task: "Deleted a task",
  list_sops: "Read matching SOPs",
  get_sop: "Read an SOP",
  list_sop_scope_targets: "Checked SOP scope targets",
  create_sop: "Created an SOP",
  update_sop: "Updated an SOP",
  delete_sop: "Deleted an SOP",
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
