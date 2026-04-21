#!/usr/bin/env node

const { TunnelClient } = require("../src/client");
const { createTunnelId } = require("../src/protocol");

const defaultServerUrl =
  process.env.RAILWAY_TUNNEL_SERVER_URL ||
  "https://relay-production-55c2.up.railway.app";
const defaultTunnelPassword =
  process.env.RAILWAY_TUNNEL_PASSWORD || undefined;
const tunnelIdPattern = /^[a-zA-Z0-9_-]{4,64}$/;

function printHelp() {
  process.stdout.write(`Usage: railway-tunnel --port <port[:id]> [--port <port[:id]> ...] [options]

Options:
  -p, --port <port[:id]>
                        Local port to expose. Repeat to expose multiple ports.
                        Example: --port 3500:docs --port 3600:admin
  -s, --server <url>    Relay base URL (default: ${defaultServerUrl})
  -i, --id <id>         Optional fixed tunnel ID. Repeat to match multiple ports.
  -P, --pass <secret>   Shared tunnel password
  -H, --host <host>     Local host to expose (default: 127.0.0.1)
  -h, --help            Show this help
`);
}

function parseTunnelId(value) {
  const tunnelId = String(value || "").trim();

  if (!tunnelIdPattern.test(tunnelId)) {
    throw new Error(
      "Tunnel IDs must be 4-64 characters using letters, numbers, _ or -.",
    );
  }

  return tunnelId;
}

function parsePortSpec(value) {
  const rawValue = String(value || "").trim();
  const match = rawValue.match(/^(\d{1,5})(?::([a-zA-Z0-9_-]{4,64}))?$/);

  if (!match) {
    throw new Error(
      `Invalid port specification "${rawValue}". Use <port> or <port:id>.`,
    );
  }

  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid local port "${match[1]}".`);
  }

  return {
    port,
    tunnelId: match[2] ? parseTunnelId(match[2]) : null,
  };
}

function parseArgs(argv) {
  const options = {
    host: "127.0.0.1",
    ids: [],
    password: defaultTunnelPassword,
    ports: [],
    server: defaultServerUrl,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }

    if (argument === "--port" || argument === "-p") {
      options.ports.push(parsePortSpec(argv[index + 1]));
      index += 1;
      continue;
    }

    if (argument === "--server" || argument === "-s") {
      options.server = argv[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--id" || argument === "-i") {
      options.ids.push(parseTunnelId(argv[index + 1]));
      index += 1;
      continue;
    }

    if (argument === "--pass" || argument === "-P") {
      options.password = argv[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--host" || argument === "-H") {
      options.host = argv[index + 1];
      index += 1;
      continue;
    }

    if (!argument.startsWith("-")) {
      options.ports.push(parsePortSpec(argument));
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

function buildTunnelConfigs(options) {
  if (options.ports.length === 0) {
    throw new Error(
      "You must provide at least one valid local port with --port <port>.",
    );
  }

  if (options.ports.length > 1 && options.ids.length > 0) {
    if (options.ids.length !== options.ports.length) {
      throw new Error(
        "When exposing multiple ports, provide one --id per --port or use inline <port:id> syntax.",
      );
    }
  }

  if (options.ids.length > options.ports.length) {
    throw new Error("You provided more tunnel IDs than ports.");
  }

  return options.ports.map((portSpec, index) => ({
    port: portSpec.port,
    tunnelId:
      portSpec.tunnelId ||
      options.ids[index] ||
      (options.ports.length === 1 && options.ids[0]) ||
      createTunnelId(),
  }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const tunnelConfigs = buildTunnelConfigs(options);
  const multipleTunnels = tunnelConfigs.length > 1;
  const clients = tunnelConfigs.map((tunnelConfig) => {
    const prefix = multipleTunnels ? `[${tunnelConfig.port}] ` : "";

    return new TunnelClient({
      serverUrl: options.server,
      host: options.host,
      password: options.password,
      port: tunnelConfig.port,
      tunnelId: tunnelConfig.tunnelId,
      logger: {
        info(message) {
          process.stderr.write(`${prefix}${message}\n`);
        },
        error(message) {
          process.stderr.write(`${prefix}${message}\n`);
        },
      },
    });
  });

  const shutdown = () => {
    for (const client of clients) {
      client.stop();
    }

    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    const registrations = await Promise.all(
      clients.map((client) => client.start()),
    );

    registrations.forEach((registration, index) => {
      if (!multipleTunnels) {
        process.stdout.write(`${registration.publicUrl}\n`);
        return;
      }

      process.stdout.write(
        `${tunnelConfigs[index].port} -> ${registration.publicUrl}\n`,
      );
    });
  } catch (error) {
    for (const client of clients) {
      client.stop();
    }

    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
