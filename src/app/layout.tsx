import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { ConvexClientProvider } from "@/components/app/providers";

export const metadata: Metadata = { title: "Cendro", description: "Notion-like operations workspace for tasks, SOPs, employees, and companies." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><ClerkProvider signInUrl="/sign-in" signUpUrl="/sign-up"><ConvexClientProvider>{children}</ConvexClientProvider></ClerkProvider></body></html>;
}
