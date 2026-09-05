import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { AdminClient } from "./ui";

export default async function AdminPage() {
  const user = await currentUser();
  if (!user) redirect("/sign-in?redirect_url=/admin");

  if (!isPlatformAdmin(user.id)) redirect("/dashboard");

  return <AdminClient />;
}
