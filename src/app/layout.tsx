import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { ConvexClientProvider } from "@/components/app/providers";
import { ThemeProvider } from "@/components/app/theme";

export const metadata: Metadata = {
  title: "Cendro",
  description: "Notion-like operations workspace for tasks, SOPs, employees, and companies.",
  applicationName: "Cendro",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Cendro" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Keeps fixed dialogs and the detail drawer inside the visible area when the
  // mobile keyboard opens.
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eef0f1" },
    { media: "(prefers-color-scheme: dark)", color: "#26282b" },
  ],
};

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
