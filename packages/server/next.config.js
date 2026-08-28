/** @type {import('next').NextConfig} */
const allowedDevOrigins = (process.env.AGENT_WEB_ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .flatMap((origin) => {
    try { return [new URL(origin).host]; } catch { return [origin.replace(/^https?:\/\//, "")]; }
  });

const nextConfig = {
  output: process.env.NEXT_STANDALONE === "1" ? "standalone" : undefined,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  ...(allowedDevOrigins.length ? { allowedDevOrigins } : {}),
  experimental: {
    externalDir: true,
  },
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    config.externals = config.externals || [];
    if (typeof config.externals === "object" && !Array.isArray(config.externals)) {
      config.externals = [config.externals];
    }
    config.externals.push({ "better-sqlite3": "commonjs better-sqlite3" });
    return config;
  },
  async headers() {
    return [
      {
        source: "/web",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, proxy-revalidate" },
          { key: "Pragma", value: "no-cache" },
          { key: "Expires", value: "0" },
        ],
      },
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Authorization, Content-Type" },
        ],
      },
    ];
  },
};

export default nextConfig;
