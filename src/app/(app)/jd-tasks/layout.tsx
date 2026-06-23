"use client";

import { useParams, usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { TaskList } from "@/components/app/task-pages";
import { cn } from "@/lib/utils";

export default function JdTasksLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id?: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const taskId = params?.id;
  const isFullView = pathname.endsWith("/full");
  const isDetail = Boolean(taskId) && !isFullView;
  const base = "/jd-tasks";
  const reduceMotion = useReducedMotion();

  if (isFullView) {
    return (
      <div className="task-fullpage">
        <div className="mx-auto w-full max-w-[760px] px-8 py-9 md:px-10">{children}</div>
      </div>
    );
  }

  return (
    <div className="relative h-full overflow-hidden">
      <div className="task-list-pane">
        <div className={cn("mx-auto w-full max-w-[1120px] px-6 py-7 md:px-10 md:py-8", isDetail && "hidden lg:block")}>
          <TaskList kind="jd" selectedId={taskId} />
        </div>
      </div>

      <AnimatePresence>
        {isDetail && (
          <motion.div
            key="jd-backdrop"
            className="task-drawer-backdrop hidden lg:block"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => router.push(base)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isDetail && (
          <motion.div
            key="jd-drawer"
            className="task-drawer"
            initial={reduceMotion ? { opacity: 0 } : { x: "100%" }}
            animate={reduceMotion ? { opacity: 1 } : { x: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { x: "100%" }}
            transition={reduceMotion ? { duration: 0.15 } : { type: "spring", damping: 34, stiffness: 360, mass: 0.9 }}
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
