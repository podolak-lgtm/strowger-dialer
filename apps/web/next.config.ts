import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cache Components stay off for now: every route reads the session and the
  // dialer screens are live by nature. Turn on per route when there is a
  // static shell worth having.
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
