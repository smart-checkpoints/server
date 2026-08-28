import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { site } from "@/lib/site";
import "./globals.css";

/** Display face, headings only. Geometric, tight, with real character. */
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

/** Body face, built for long measures. */
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

/** Every technical value in the console: coordinates, distances, plates, keys. */
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: `${site.name} ${site.surface}`,
    template: `%s · ${site.name} ${site.surface}`,
  },
  description: site.description,
  applicationName: `${site.name} ${site.surface}`,

  // The console is an operator surface on someone's own deployment, not a
  // page for the open web. The marketing site is the thing that gets indexed.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${inter.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body
        className="bg-bg font-sans text-text antialiased"
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
