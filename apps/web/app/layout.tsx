import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { Inter } from "next/font/google";
import { Shell } from "@/components/Shell";
import { Providers } from "./providers";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://oddra-two.vercel.app"),
  title: { default: "Oddra — Every Match. Every Moment. Onchain.", template: "%s · Oddra" },
  description:
    "Automated virtual football on Robinhood Chain. A new simulated match every 20 minutes, verifiable results and on-chain betting in test USDG.",
  // icon, apple-icon, opengraph-image and twitter-image come from the files in this folder
  openGraph: { title: "Oddra", description: "Every Match. Every Moment. Onchain.", siteName: "Oddra" },
  twitter: { card: "summary_large_image", title: "Oddra", description: "Every Match. Every Moment. Onchain." },
};

export const viewport: Viewport = { themeColor: "#050505", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} ${inter.variable}`}>
      <body>
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
