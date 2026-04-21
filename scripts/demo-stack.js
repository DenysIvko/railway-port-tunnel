const { spawn } = require("node:child_process");
const net = require("node:net");

function findAvailablePort(preferredPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.unref();
    server.on("error", () => {
      const fallbackServer = net.createServer();
      fallbackServer.unref();
      fallbackServer.on("error", reject);
      fallbackServer.listen(0, "127.0.0.1", () => {
        const address = fallbackServer.address();
        fallbackServer.close(() => resolve(address.port));
      });
    });

    server.listen(preferredPort, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function start(name, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.stderr.write(`${name} exited from signal ${signal}\n`);
      return;
    }

    if (code !== 0) {
      process.stderr.write(`${name} exited with code ${code}\n`);
      process.exitCode = code;
    }
  });

  return child;
}

async function main() {
  const relayPort = String(
    process.env.RELAY_PORT || (await findAvailablePort(8080)),
  );
  const demoPort = String(
    process.env.DEMO_PORT || (await findAvailablePort(3500)),
  );
  const relayBaseUrl =
    process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${relayPort}`;

  const children = [
    start("relay", ["server/index.js"], {
      PORT: relayPort,
      PUBLIC_BASE_URL: relayBaseUrl,
    }),
    start("demo-page", ["examples/test-page.js"], {
      PORT: demoPort,
    }),
  ];

  function shutdown(signal) {
    for (const child of children) {
      if (!child.killed) {
        child.kill(signal);
      }
    }
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.stdout.write(`Relay: ${relayBaseUrl}\n`);
  process.stdout.write(`Demo page: http://127.0.0.1:${demoPort}\n`);
  process.stdout.write(
    `Next: npm run tunnel -- --server ${relayBaseUrl} --port ${demoPort}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
