import { SignIn } from "@clerk/nextjs";

function safeRedirectUrl(value: string | string[] | undefined) {
  const redirectUrl = Array.isArray(value) ? value[0] : value;
  if (!redirectUrl || !redirectUrl.startsWith("/") || redirectUrl.startsWith("//") || redirectUrl.includes("\\")) return "/dashboard";
  return redirectUrl;
}

export default async function Page({ searchParams }: { searchParams: Promise<{ redirect_url?: string | string[] }> }) {
  const redirectUrl = safeRedirectUrl((await searchParams).redirect_url);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--canvas-soft)]">
      <SignIn fallbackRedirectUrl={redirectUrl} forceRedirectUrl={redirectUrl} signUpFallbackRedirectUrl={redirectUrl} signUpForceRedirectUrl={redirectUrl} />
    </main>
  );
}
