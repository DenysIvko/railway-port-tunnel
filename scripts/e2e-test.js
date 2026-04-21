const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const { setTimeout: delay } = require("node:timers/promises");

function startProcess(name, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`);
  });

  return child;
}

async function waitForHttp(url, timeoutMs = 10_000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
    } catch {
      await delay(200);
      continue;
    }

    await delay(200);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForTunnelUrl(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let buffered = "";

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the tunnel URL."));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    }

    function onExit(code) {
      cleanup();
      reject(new Error(`Tunnel CLI exited before printing a URL (code ${code}).`));
    }

    function onData(chunk) {
      buffered += chunk.toString();
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
          cleanup();
          resolve(trimmed);
          return;
        }
      }
    }

    child.stdout.on("data", onData);
    child.on("exit", onExit);
  });
}

function findAvailablePort(preferredPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.unref();
    server.on("error", () => {
      const fallbackServer = net.createServer();
      fallbackServer.unref();
      fallbackServer.on("error", reject);
      fallbackServer.listen(0, () => {
        const address = fallbackServer.address();
        fallbackServer.close(() => resolve(address.port));
      });
    });

    server.listen(preferredPort, () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function terminate(child) {
  if (!child || child.killed) {
    return;
  }

  child.kill("SIGTERM");
  await new Promise((resolve) => {
    child.once("exit", resolve);
    setTimeout(resolve, 1_000);
  });
}

async function main() {
  const pagePort = await findAvailablePort(3500);
  const relayPort = await findAvailablePort(8080);
  const relayBaseUrl = `http://127.0.0.1:${relayPort}`;

  const demoPage = startProcess("page", ["examples/test-page.js"], {
    PORT: String(pagePort),
  });
  const relay = startProcess("relay", ["server/index.js"], {
    PORT: String(relayPort),
    PUBLIC_BASE_URL: relayBaseUrl,
  });
  let tunnel;

  try {
    await waitForHttp(`${relayBaseUrl}/health`);
    await waitForHttp(`http://127.0.0.1:${pagePort}`);
    tunnel = startProcess("cli", [
      "bin/railway-tunnel.js",
      "--server",
      relayBaseUrl,
      "--port",
      String(pagePort),
      "--id",
      "e2etest",
    ]);
    const publicUrl = await waitForTunnelUrl(tunnel);
    const response = await waitForHttp(publicUrl);
    const html = await response.text();

    assert.match(html, /Tunnel Demo/);
    assert.match(html, /served from your local machine through the tunnel/i);

    process.stdout.write(`\nVerified public tunnel URL: ${publicUrl}\n`);
  } finally {
    await Promise.all([terminate(tunnel), terminate(relay), terminate(demoPage)]);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
