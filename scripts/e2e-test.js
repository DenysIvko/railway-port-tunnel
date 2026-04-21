const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
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

async function waitForTunnelUrls(child, expectedCount, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const registrations = [];

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for tunnel URLs."));
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
        const match = trimmed.match(
          /^(?:(\d+)\s+->\s+)?(https?:\/\/[^\s]+)$/,
        );

        if (!match) {
          continue;
        }

        registrations.push({
          port: match[1] ? Number(match[1]) : null,
          publicUrl: match[2],
        });

        if (registrations.length >= expectedCount) {
          cleanup();
          resolve(registrations);
          return;
        }
      }
    }

    child.stdout.on("data", onData);
    child.on("exit", onExit);
  });
}

async function requestWithHostHeader(publicUrl, relayPort) {
  const url = new URL(publicUrl);

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: relayPort,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          host: url.host,
        },
      },
      (response) => {
        const chunks = [];

        response.on("data", (chunk) => {
          chunks.push(chunk);
        });

        response.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            statusCode: response.statusCode || 0,
          });
        });
      },
    );

    request.on("error", reject);
    request.end();
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

async function waitForExit(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for process exit."));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      child.off("exit", onExit);
    }

    function onExit(code, signal) {
      cleanup();
      resolve({ code, signal });
    }

    child.on("exit", onExit);
  });
}

async function main() {
  const sharedPassword = "31415";
  const firstPagePort = await findAvailablePort(3500);
  const firstPage = startProcess("page-a", ["examples/test-page.js"], {
    PAGE_NAME: "Alpha Demo",
    PORT: String(firstPagePort),
  });
  let secondPage;
  let pathRelay;
  let hostRelay;
  let pathTunnel;
  let hostTunnel;

  try {
    await waitForHttp(`http://127.0.0.1:${firstPagePort}`);

    const secondPagePort = await findAvailablePort(3600);
    secondPage = startProcess("page-b", ["examples/test-page.js"], {
      PAGE_NAME: "Beta Demo",
      PORT: String(secondPagePort),
    });
    await waitForHttp(`http://127.0.0.1:${secondPagePort}`);

    const pathRelayPort = await findAvailablePort(8080);
    const pathRelayBaseUrl = `http://127.0.0.1:${pathRelayPort}`;
    pathRelay = startProcess("relay-path", ["server/index.js"], {
      PORT: String(pathRelayPort),
      PUBLIC_BASE_URL: pathRelayBaseUrl,
      TUNNEL_PASSWORD: sharedPassword,
    });
    await waitForHttp(`${pathRelayBaseUrl}/health`);

    pathTunnel = startProcess("cli-path", [
      "bin/railway-tunnel.js",
      "--server",
      pathRelayBaseUrl,
      "--pass",
      sharedPassword,
      "--port",
      `${firstPagePort}:alpha`,
      "--port",
      `${secondPagePort}:beta`,
    ]);

    const pathRegistrations = await waitForTunnelUrls(pathTunnel, 2);
    const pathByPort = new Map(
      pathRegistrations.map((registration) => [registration.port, registration]),
    );

    const alphaPathResponse = await waitForHttp(
      pathByPort.get(firstPagePort).publicUrl,
    );
    const betaPathResponse = await waitForHttp(
      pathByPort.get(secondPagePort).publicUrl,
    );
    const alphaPathHtml = await alphaPathResponse.text();
    const betaPathHtml = await betaPathResponse.text();

    assert.match(alphaPathHtml, /Alpha Demo/);
    assert.match(betaPathHtml, /Beta Demo/);

    const unauthorizedTunnel = startProcess("cli-denied", [
      "bin/railway-tunnel.js",
      "--server",
      pathRelayBaseUrl,
      "--port",
      `${firstPagePort}:deniedalpha`,
    ]);
    const deniedExit = await waitForExit(unauthorizedTunnel);
    assert.equal(deniedExit.code, 1);

    process.stdout.write(
      `\nVerified path-routed tunnel URLs: ${pathByPort.get(firstPagePort).publicUrl} and ${pathByPort.get(secondPagePort).publicUrl}\n`,
    );
    process.stdout.write("Verified password rejection for an unauthorized tunnel client\n");

    const hostRelayPort = await findAvailablePort(8181);
    const hostRelayBaseUrl = `http://127.0.0.1:${hostRelayPort}`;
    hostRelay = startProcess("relay-host", ["server/index.js"], {
      PORT: String(hostRelayPort),
      PUBLIC_BASE_URL: hostRelayBaseUrl,
      PUBLIC_WILDCARD_DOMAIN: "tunnels.example.test",
      TUNNEL_PASSWORD: sharedPassword,
    });
    await waitForHttp(`${hostRelayBaseUrl}/health`);

    hostTunnel = startProcess("cli-host", [
      "bin/railway-tunnel.js",
      "--server",
      hostRelayBaseUrl,
      "--pass",
      sharedPassword,
      "--port",
      `${firstPagePort}:alphahost`,
      "--port",
      `${secondPagePort}:betahost`,
    ]);

    const hostRegistrations = await waitForTunnelUrls(hostTunnel, 2);
    const hostAlphaRegistration = hostRegistrations.find((registration) =>
      registration.publicUrl.includes("alphahost."),
    );
    const hostBetaRegistration = hostRegistrations.find((registration) =>
      registration.publicUrl.includes("betahost."),
    );

    assert.ok(hostAlphaRegistration, "Missing alpha host-routed tunnel URL.");
    assert.ok(hostBetaRegistration, "Missing beta host-routed tunnel URL.");

    const alphaHostResponse = await requestWithHostHeader(
      hostAlphaRegistration.publicUrl,
      hostRelayPort,
    );
    const betaHostResponse = await requestWithHostHeader(
      hostBetaRegistration.publicUrl,
      hostRelayPort,
    );

    assert.equal(alphaHostResponse.statusCode, 200);
    assert.equal(betaHostResponse.statusCode, 200);
    assert.match(alphaHostResponse.body, /Alpha Demo/);
    assert.match(betaHostResponse.body, /Beta Demo/);

    process.stdout.write(
      `Verified host-routed tunnel URLs: ${hostAlphaRegistration.publicUrl} and ${hostBetaRegistration.publicUrl}\n`,
    );
  } finally {
    await Promise.all([
      terminate(hostTunnel),
      terminate(pathTunnel),
      terminate(hostRelay),
      terminate(pathRelay),
      terminate(secondPage),
      terminate(firstPage),
    ]);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
