import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    const backendHostPort = process.env.NEST_API_HOSTPORT;
    const backendUrl = (
      process.env.NEST_API_URL ||
      (backendHostPort ? `http://${backendHostPort}` : "http://localhost:8000")
    ).replace(/\/$/, "");
    const grafanaUrl = (process.env.GRAFANA_URL || "http://localhost:3003").replace(/\/$/, "");
    return [
      { source: "/api/backend/:path*", destination: `${backendUrl}/:path*` },
      { source: "/grafana", destination: `${grafanaUrl}/grafana` },
      { source: "/grafana/:path*", destination: `${grafanaUrl}/grafana/:path*` },
    ];
  },
};

export default nextConfig;
