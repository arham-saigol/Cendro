import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export function formatDate(value?: number | string | null) { if(value===null||value===undefined) return "—"; const date=new Date(value); if(Number.isNaN(date.getTime())) return "—"; return new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",year:"numeric"}).format(date); }
export function initials(name?: string | null, email?: string | null) { const base=name?.trim()||email?.split("@")[0]||"U"; return base.split(/\s+/).slice(0,2).map(p=>p[0]?.toUpperCase()).join(""); }
