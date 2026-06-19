import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AdminClient } from "./ui";

export default async function AdminPage() {
  const user = await currentUser();
  if (!user) redirect("/sign-in?redirect_url=/admin");

  const email = user.primaryEmailAddress?.emailAddress?.toLowerCase();
  if (!process.env.PLATFORM_ADMIN_EMAIL || email !== process.env.PLATFORM_ADMIN_EMAIL.toLowerCase()) redirect("/dashboard");

  return <AdminClient />;
}
