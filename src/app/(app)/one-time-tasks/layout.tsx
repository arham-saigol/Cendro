"use client";

import { useParams } from "next/navigation";
import { DetailDrawerLayout } from "@/components/app/detail-drawer-layout";
import { TaskDeadlineProvider, TaskList } from "@/components/app/task-pages";

export default function OneTimeTasksLayout({ children }: { children: React.ReactNode }) {
  const taskId = useParams<{ id?: string }>()?.id;
  return <TaskDeadlineProvider><DetailDrawerLayout base="/one-time-tasks" detailId={taskId} drawerKey="one-drawer" label="task" list={<TaskList kind="one" selectedId={taskId} />}>{children}</DetailDrawerLayout></TaskDeadlineProvider>;
}
