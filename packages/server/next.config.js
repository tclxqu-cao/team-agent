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
    serverComponentsExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
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
    config.externals.push({ "web-push": "commonjs web-push" });
    config.externals.push({ "@anthropic-ai/claude-agent-sdk": "commonjs @anthropic-ai/claude-agent-sdk" });
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
          // PATCH/DELETE 供移动原生壳（capacitor://localhost 等跨源源）预检使用
          { key: "Access-Control-Allow-Methods", value: "GET, POST, PATCH, DELETE, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Authorization, Content-Type" },
        ],
      },
    ];
  },
};

export default nextConfig;
