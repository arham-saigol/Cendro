"use client";

import { useParams } from "next/navigation";
import { DetailDrawerLayout } from "@/components/app/detail-drawer-layout";
import { TaskList } from "@/components/app/task-pages";

export default function JdTasksLayout({ children }: { children: React.ReactNode }) {
  const taskId = useParams<{ id?: string }>()?.id;
  return <DetailDrawerLayout base="/jd-tasks" detailId={taskId} drawerKey="jd-drawer" label="task" list={<TaskList kind="jd" selectedId={taskId} />}>{children}</DetailDrawerLayout>;
}
