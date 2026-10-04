import * as React from "react";
import { cn } from "@/lib/utils";

export const inputClassName =
  "h-8 w-full rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-2.5 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)] focus:border-[var(--focus-ring)]";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(inputClassName, className)} {...props} />
));
Input.displayName = "Input";
