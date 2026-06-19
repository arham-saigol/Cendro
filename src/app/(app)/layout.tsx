import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app/app-shell";

export default async function Layout({ children }: { children: React.ReactNode }) {
  const { userId } = await auth({ treatPendingAsSignedOut: true });
  if (!userId) redirect("/sign-in");

  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress?.toLowerCase();
  const platformAdminEmail = process.env.PLATFORM_ADMIN_EMAIL?.toLowerCase();
  const isPlatformAdmin = Boolean(platformAdminEmail && email === platformAdminEmail);

  return <AppShell isPlatformAdmin={isPlatformAdmin}>{children}</AppShell>;
}
