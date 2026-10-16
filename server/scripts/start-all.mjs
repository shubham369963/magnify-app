import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";

const children = [];
let stopping = false;

function start(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? "/app",
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(`${name} failed to start: ${error.message}`);
    shutdown(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`${name} exited unexpectedly (code=${code}, signal=${signal}).`);
      shutdown(code || 1);
    }
  });
  return child;
}

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  const pending = children
    .filter((child) => child.exitCode === null && child.signalCode === null)
    .map((child) => once(child, "exit"));
  for (const child of children) child.kill("SIGTERM");

  const forceExit = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(exitCode);
  }, 10000);
  forceExit.unref();
  await Promise.all(pending);
  clearTimeout(forceExit);
  process.exit(exitCode);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

const mode = process.env.MAGNIFY_PROCESS_MODE ?? "all";
if (mode === "api") {
  start("API", process.execPath, ["server/dist/main.js"]);
} else if (mode === "worker") {
  start("Worker", process.execPath, ["server/dist/worker-node/worker.js"]);
} else {
  const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  const redis = new URL(redisUrl);
  const localRedis = ["localhost", "127.0.0.1", "::1"].includes(redis.hostname);
  const backendEnv = {
    ...process.env,
    APP_PORT: "8000",
    REDIS_URL: redisUrl,
    WORKER_METRICS_PORT: "9464",
  };

  if (localRedis) {
    start("Redis", "redis-server", [
      "--bind", "127.0.0.1",
      "--port", String(Number(redis.port || 6379)),
      "--save", "",
      "--appendonly", "no",
      "--dir", "/tmp/redis",
    ]);
  }

  start("API", process.execPath, ["server/dist/main.js"], {
    env: { ...backendEnv, METRICS_SERVICE_NAME: "magnify-api" },
  });
  start("Worker", process.execPath, ["server/dist/worker-node/worker.js"], {
    env: { ...backendEnv, METRICS_SERVICE_NAME: "magnify-worker" },
  });

  if (process.env.GRAFANA_ADMIN_USER && process.env.GRAFANA_ADMIN_PASSWORD) {
    start("Prometheus", "prometheus", [
      "--config.file=/app/server/monitoring/prometheus.render.yml",
      "--storage.tsdb.path=/tmp/prometheus",
      "--storage.tsdb.retention.time=7d",
      "--web.listen-address=127.0.0.1:9090",
    ]);
    start("Grafana", "grafana-server", ["--homepath=/usr/share/grafana"], {
      env: {
        ...process.env,
        GF_SERVER_HTTP_ADDR: "127.0.0.1",
        GF_SERVER_HTTP_PORT: "3003",
        GF_SERVER_ROOT_URL: "%(protocol)s://%(domain)s/grafana/",
        GF_SERVER_SERVE_FROM_SUB_PATH: "true",
        GF_SECURITY_ADMIN_USER: process.env.GRAFANA_ADMIN_USER,
        GF_SECURITY_ADMIN_PASSWORD: process.env.GRAFANA_ADMIN_PASSWORD,
        GF_USERS_ALLOW_SIGN_UP: "false",
        GF_PATHS_DATA: "/tmp/grafana",
        GF_PATHS_LOGS: "/tmp/grafana/log",
        GF_PATHS_PLUGINS: "/tmp/grafana/plugins",
        GF_PATHS_PROVISIONING: "/app/server/monitoring/grafana/provisioning-render",
      },
    });
  } else {
    console.warn("Grafana is disabled. Set GRAFANA_ADMIN_USER and GRAFANA_ADMIN_PASSWORD to enable it.");
  }

  start("Frontend", process.execPath, [
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "0.0.0.0",
    "--port",
    process.env.PORT || "10000",
  ], { cwd: "/app/client" });
}