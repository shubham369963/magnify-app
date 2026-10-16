import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    const backendHostPort = process.env.NEST_API_HOSTPORT;
    const backendUrl = (
      process.env.NEST_API_URL ||
      (backendHostPort ? `http://${backendHostPort}` : "http://localhost:8000")
    ).replace(/\/$/, "");
    return [
      { source: "/api/backend/:path*", destination: `${backendUrl}/:path*` },
    ];
  },
};

export default nextConfig;
