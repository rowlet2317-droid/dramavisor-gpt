import type { NextConfig } from "next";

const config: NextConfig = {
  experimental: { useTypeScriptCli: true },
  serverExternalPackages: [
    "@napi-rs/canvas",
    "@napi-rs/canvas-linux-x64-gnu",
    "@napi-rs/canvas-linux-x64-musl",
  ],
};

export default config;
