"use client";

import { useParams, useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { TaskList } from "@/components/app/task-pages";
import { cn } from "@/lib/utils";

export default function OneTimeTasksLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id?: string }>();
  const router = useRouter();
  const taskId = params?.id;
  const isDetail = Boolean(taskId);
  const base = "/one-time-tasks";
  const reduceMotion = useReducedMotion();

  return (
    <div className="relative h-full overflow-hidden">
      <div className="task-list-pane">
        <div className={cn("mx-auto w-full max-w-[1120px] px-6 py-7 md:px-10 md:py-8", isDetail && "hidden lg:block")}>
          <TaskList kind="one" selectedId={taskId} />
        </div>
      </div>

      {isDetail && (
        <button
          type="button"
          aria-label="Close task details"
          className="task-drawer-click-target hidden lg:block"
          onClick={() => router.push(base)}
        />
      )}

      <AnimatePresence>
        {isDetail && (
          <motion.div
            key="one-drawer"
            className="task-drawer"
            initial={reduceMotion ? { opacity: 0 } : { x: 32, opacity: 0 }}
            animate={reduceMotion ? { opacity: 1 } : { x: 0, opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { x: 24, opacity: 0 }}
            transition={reduceMotion ? { duration: 0.1 } : { duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="task-drawer-inner">
              <div className="mx-auto w-full max-w-[560px] px-6 py-7 md:px-9 md:py-8">{children}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
