import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { ConvexClientProvider } from "@/components/app/providers";
import { ThemeProvider } from "@/components/app/theme";

export const metadata: Metadata = { title: "Cendro", description: "Notion-like operations workspace for tasks, SOPs, employees, and companies." };

const themeScript = `
(() => {
  try {
    const stored = localStorage.getItem("cendro.theme");
    const theme = stored === "light" || stored === "dark" ? stored : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch {}
})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ThemeProvider>
          <ClerkProvider signInUrl="/sign-in" signUpUrl="/sign-up">
            <ConvexClientProvider>{children}</ConvexClientProvider>
          </ClerkProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
