import { cn } from "@/lib/utils";

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("rounded-md border border-[var(--hairline)] bg-[var(--surface)]", className)}>{children}</div>;
}
