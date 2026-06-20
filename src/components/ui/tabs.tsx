"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

export const Tabs = TabsPrimitive.Root;
export const TabsList = ({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) => (
  <TabsPrimitive.List className={cn("inline-flex gap-0.5 rounded-md border border-[var(--hairline)] bg-[var(--surface-muted)] p-0.5", className)} {...props} />
);
export const TabsTrigger = ({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) => (
  <TabsPrimitive.Trigger
    className={cn(
      "rounded px-2.5 py-1 text-sm text-[var(--ink-muted)] outline-none transition-colors hover:text-[var(--ink)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] data-[state=active]:bg-[var(--surface)] data-[state=active]:text-[var(--ink)]",
      className,
    )}
    {...props}
  />
);
export const TabsContent = TabsPrimitive.Content;
