import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export default async function Page() {
  const { userId } = await auth();
  redirect(userId ? "/dashboard" : "/sign-in");
}
