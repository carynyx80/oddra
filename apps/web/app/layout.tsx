import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { Inter } from "next/font/google";
import { Shell } from "@/components/Shell";
import { Providers } from "./providers";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Oddra — Every Match. Every Moment. Onchain.", template: "%s · Oddra" },
  description:
    "Automated virtual football on Robinhood Chain. A new simulated match every 20 minutes, verifiable results and on-chain betting in test USDG.",
  openGraph: { title: "Oddra", description: "Every Match. Every Moment. Onchain.", images: ["/oddra-token.svg"] },
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
