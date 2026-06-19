import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export function formatDate(value?: number | string | null) { return value ? new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",year:"numeric"}).format(new Date(value)) : "—"; }
export function initials(name?: string | null, email?: string | null) { const base=name?.trim()||email?.split("@")[0]||"U"; return base.split(/\s+/).slice(0,2).map(p=>p[0]?.toUpperCase()).join(""); }
