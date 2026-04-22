const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const { inspect } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");

function startProcess(name, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.collectedStdout = "";
  child.collectedStderr = "";

  child.stdout.on("data", (chunk) => {
    child.collectedStdout += chunk.toString();
    process.stdout.write(`[${name}] ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    child.collectedStderr += chunk.toString();
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

async function waitForCondition(check, timeoutMs = 10_000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const result = check();
    if (result) {
      return result;
    }

    await delay(100);
  }

  throw new Error("Timed out waiting for condition.");
}

async function waitForTunnelUrls(child, expectedCount, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let buffered = child.collectedStdout || "";
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
    onData("");
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

function assertNotificationBodiesEqual(actualBodies, expectedBodies) {
  const normalize = (body) => JSON.stringify(body);
  const actual = actualBodies.map(normalize).sort();
  const expected = expectedBodies.map(normalize).sort();
  assert.deepEqual(
    actual,
    expected,
    `Expected notification bodies ${inspect(expectedBodies)} but received ${inspect(actualBodies)}`,
  );
}

async function main() {
  const sharedPassword = "31415";
  const receivedNotifications = [];
  const notifierAuthHeader = "Bearer test-notifier-token";
  const notificationServer = http.createServer(async (request, response) => {
    const chunks = [];

    request.on("data", (chunk) => {
      chunks.push(chunk);
    });

    request.on("end", () => {
      receivedNotifications.push({
        authorization: request.headers.authorization || "",
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
      });
      response.statusCode = 200;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ ok: true }));
    });
  });
  const notifierPort = await findAvailablePort(9090);
  await new Promise((resolve, reject) => {
    notificationServer.once("error", reject);
    notificationServer.listen(notifierPort, "127.0.0.1", resolve);
  });
  const notifierUrl = `http://127.0.0.1:${notifierPort}/v1/ip-notifications`;
  const firstPagePort = await findAvailablePort(3500);
  const firstPage = startProcess("page-a", ["examples/test-page.js"], {
    PAGE_NAME: "Alpha Demo",
    PORT: String(firstPagePort),
  });
  let secondPage;
  let pathRelay;
  let hostRelay;
  let pathTunnelAlpha;
  let pathTunnelBeta;
  let hostTunnelAlpha;
  let hostTunnelBeta;

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
      TUNNEL_CREATED_NOTIFICATION_URL: notifierUrl,
      TUNNEL_CREATED_NOTIFICATION_TOKEN: notifierAuthHeader.slice("Bearer ".length),
      TUNNEL_CREATED_NOTIFICATION_LABEL: "Tunnel",
    });
    await waitForHttp(`${pathRelayBaseUrl}/health`);

    pathTunnelAlpha = startProcess("cli-path-alpha", [
      "bin/railway-tunnel.js",
      "--server",
      pathRelayBaseUrl,
      "--pass",
      sharedPassword,
      "--port",
      String(firstPagePort),
      "--subdomain",
      "alpha",
    ]);
    pathTunnelBeta = startProcess("cli-path-beta", [
      "bin/railway-tunnel.js",
      "--server",
      pathRelayBaseUrl,
      "--pass",
      sharedPassword,
      "--port",
      String(secondPagePort),
      "--subdomain",
      "beta",
    ]);

    const [alphaPathRegistration] = await waitForTunnelUrls(pathTunnelAlpha, 1);
    const [betaPathRegistration] = await waitForTunnelUrls(pathTunnelBeta, 1);

    const alphaPathResponse = await waitForHttp(
      alphaPathRegistration.publicUrl,
    );
    const betaPathResponse = await waitForHttp(
      betaPathRegistration.publicUrl,
    );
    const alphaPathHtml = await alphaPathResponse.text();
    const betaPathHtml = await betaPathResponse.text();

    assert.match(alphaPathHtml, /Alpha Demo/);
    assert.match(betaPathHtml, /Beta Demo/);
    await waitForCondition(() => receivedNotifications.length >= 2);
    assertNotificationBodiesEqual(
      receivedNotifications.slice(0, 2).map((notification) => notification.body),
      [
        {
          message: `Tunnel created: ${alphaPathRegistration.publicUrl}`,
          label: "Tunnel",
        },
        {
          message: `Tunnel created: ${betaPathRegistration.publicUrl}`,
          label: "Tunnel",
        },
      ],
    );
    assert.deepEqual(
      receivedNotifications.slice(0, 2).map((notification) => notification.authorization),
      [notifierAuthHeader, notifierAuthHeader],
    );

    const unauthorizedTunnel = startProcess("cli-denied", [
      "bin/railway-tunnel.js",
      "--server",
      pathRelayBaseUrl,
      "--port",
      String(firstPagePort),
      "--subdomain",
      "deniedalpha",
    ]);
    const deniedExit = await waitForExit(unauthorizedTunnel);
    assert.equal(deniedExit.code, 1);
    assert.match(unauthorizedTunnel.collectedStderr, /Invalid tunnel password/);
    await waitForCondition(() => receivedNotifications.length >= 3);
    assert.deepEqual(receivedNotifications[2].body, {
      message: "Tunnel auth failed: deniedalpha from 127.0.0.1",
      label: "Tunnel",
    });
    assert.equal(receivedNotifications[2].authorization, notifierAuthHeader);

    process.stdout.write(
      `\nVerified path-routed tunnel URLs from separate CLI processes: ${alphaPathRegistration.publicUrl} and ${betaPathRegistration.publicUrl}\n`,
    );
    process.stdout.write("Verified password rejection for an unauthorized tunnel client\n");

    const hostRelayPort = await findAvailablePort(8181);
    const hostRelayBaseUrl = `http://127.0.0.1:${hostRelayPort}`;
    hostRelay = startProcess("relay-host", ["server/index.js"], {
      PORT: String(hostRelayPort),
      PUBLIC_BASE_URL: hostRelayBaseUrl,
      PUBLIC_WILDCARD_DOMAIN: "tunnels.example.test",
      TUNNEL_PASSWORD: sharedPassword,
      TUNNEL_CREATED_NOTIFICATION_URL: notifierUrl,
      TUNNEL_CREATED_NOTIFICATION_TOKEN: notifierAuthHeader.slice("Bearer ".length),
      TUNNEL_CREATED_NOTIFICATION_LABEL: "Tunnel",
    });
    await waitForHttp(`${hostRelayBaseUrl}/health`);

    hostTunnelAlpha = startProcess("cli-host-alpha", [
      "bin/railway-tunnel.js",
      "--server",
      hostRelayBaseUrl,
      "--pass",
      sharedPassword,
      "--port",
      String(firstPagePort),
      "--subdomain",
      "alphahost",
    ]);
    hostTunnelBeta = startProcess("cli-host-beta", [
      "bin/railway-tunnel.js",
      "--server",
      hostRelayBaseUrl,
      "--pass",
      sharedPassword,
      "--port",
      String(secondPagePort),
      "--subdomain",
      "betahost",
    ]);

    const [hostAlphaRegistration] = await waitForTunnelUrls(hostTunnelAlpha, 1);
    const [hostBetaRegistration] = await waitForTunnelUrls(hostTunnelBeta, 1);

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
    await waitForCondition(() => receivedNotifications.length >= 4);
    assertNotificationBodiesEqual(
      receivedNotifications.slice(3, 5).map((notification) => notification.body),
      [
        {
          message: `Tunnel created: ${hostAlphaRegistration.publicUrl}`,
          label: "Tunnel",
        },
        {
          message: `Tunnel created: ${hostBetaRegistration.publicUrl}`,
          label: "Tunnel",
        },
      ],
    );

    const hostTunnelConflict = startProcess("cli-host-conflict", [
      "bin/railway-tunnel.js",
      "--server",
      hostRelayBaseUrl,
      "--pass",
      sharedPassword,
      "--port",
      String(secondPagePort),
      "--subdomain",
      "alphahost",
    ]);
    const conflictExit = await waitForExit(hostTunnelConflict);
    assert.equal(conflictExit.code, 1);
    assert.match(
      hostTunnelConflict.collectedStderr,
      /Requested subdomain "alphahost\.tunnels\.example\.test" is already in use\./,
    );
    await delay(250);
    assert.equal(receivedNotifications.length, 5);

    process.stdout.write(
      `Verified host-routed tunnel URLs from separate CLI processes: ${hostAlphaRegistration.publicUrl} and ${hostBetaRegistration.publicUrl}\n`,
    );
    process.stdout.write(
      "Verified requested subdomain collision fails with a clear error\n",
    );
    process.stdout.write(
      "Verified successful registrations and invalid-password attempts send notifications\n",
    );
  } finally {
    await Promise.all([
      terminate(hostTunnelBeta),
      terminate(hostTunnelAlpha),
      terminate(pathTunnelBeta),
      terminate(pathTunnelAlpha),
      terminate(hostRelay),
      terminate(pathRelay),
      terminate(secondPage),
      terminate(firstPage),
    ]);
    await new Promise((resolve) => {
      notificationServer.close(resolve);
    });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
