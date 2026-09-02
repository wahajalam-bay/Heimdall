import { cookies } from "next/headers";
import type { Metadata, Viewport } from "next";
import { DENSITY_COOKIE, isDensity, NAV_COOKIE } from "@/lib/nav-state";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "ProcurementOS",
    template: "%s · ProcurementOS",
  },
  description:
    "Internal procurement operating system — requisitions, sourcing, CPC, purchase orders, receiving, GRN, inventory, invoicing and vendor governance.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f8fa" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0d11" },
  ],
};

/**
 * Applies the stored theme before first paint so the app never flashes the wrong
 * palette. The navigation width is not done here — it is a cookie, so the server
 * renders the correct sidebar rather than correcting it after hydration.
 */
const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem("pos.theme");if(!t){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.dataset.theme=t;}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  const rail = jar.get(NAV_COOKIE)?.value === "rail";
  const stored = jar.get(DENSITY_COOKIE)?.value;
  const density = isDensity(stored) ? stored : "comfortable";
  return (
    <html
      lang="en"
      data-nav={rail ? "rail" : "full"}
      data-density={density}
      suppressHydrationWarning
    >
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
