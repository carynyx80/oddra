import type { NextConfig } from "next";

const security = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@oddra/engine", "@oddra/shared", "@oddra/db"],
  serverExternalPackages: ["@prisma/client"],
  async headers() {
    return [{ source: "/:path*", headers: security }];
  },
  webpack(cfg) {
    // wallet libraries reference optional native/react-native modules that are not used in the browser
    cfg.resolve.fallback = {
      ...cfg.resolve.fallback,
      "@react-native-async-storage/async-storage": false,
      "pino-pretty": false,
    };
    // the Base Account connector pulls in Coinbase's CDP SDK, whose optional x402 payment modules Oddra never uses
    cfg.resolve.alias = {
      ...cfg.resolve.alias,
      "@x402/core/client": false,
      "@x402/evm": false,
      "@x402/evm/exact/client": false,
      "@x402/evm/upto/client": false,
      "@x402/svm/exact/client": false,
    };
    cfg.externals.push("pino-pretty", "lokijs", "encoding");
    return cfg;
  },
};

export default config;
