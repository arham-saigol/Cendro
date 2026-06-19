import { z } from "zod";
const serverSchema=z.object({CLERK_SECRET_KEY:z.string().min(1),PLATFORM_ADMIN_EMAIL:z.string().email(),NEXT_PUBLIC_CONVEX_URL:z.string().url(),AI_GATEWAY_API_KEY:z.string().min(1),AI_MODEL:z.string().default("deepseek/deepseek-v4-pro")});
const clientSchema=z.object({NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:z.string().min(1),NEXT_PUBLIC_CONVEX_URL:z.string().url()});
export function serverEnv(){return serverSchema.parse(process.env)}
export function safeServerEnv(){return serverSchema.safeParse(process.env)}
export function clientEnv(){return clientSchema.safeParse({NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,NEXT_PUBLIC_CONVEX_URL:process.env.NEXT_PUBLIC_CONVEX_URL})}
