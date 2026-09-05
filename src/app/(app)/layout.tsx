import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { AppShell } from "@/components/app/app-shell";

export default async function Layout({ children }: { children: React.ReactNode }) {
  const { userId } = await auth({ treatPendingAsSignedOut: true });
  if (!userId) redirect("/sign-in");

  return <AppShell isPlatformAdmin={isPlatformAdmin(userId)}>{children}</AppShell>;
}
