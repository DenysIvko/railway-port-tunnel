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
  process.stdout.write(`Usage: railway-tunnel --port <port> [options]

Options:
  -p, --port <port>     Local port to expose
  -s, --server <url>    Relay base URL (default: ${defaultServerUrl})
  -n, --subdomain <id>  Requested subdomain name
  -i, --id <id>         Legacy alias for --subdomain
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

function parsePort(value) {
  const rawValue = String(value || "").trim();
  const match = rawValue.match(/^(\d{1,5})$/);

  if (!match) {
    throw new Error(`Invalid port "${rawValue}". Use a value like 3000.`);
  }

  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid local port "${match[1]}".`);
  }

  return port;
}

function parseArgs(argv) {
  const options = {
    host: "127.0.0.1",
    password: defaultTunnelPassword,
    port: null,
    server: defaultServerUrl,
    tunnelId: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }

    if (argument === "--port" || argument === "-p") {
      if (options.port != null) {
        throw new Error("Only one --port value is allowed per command.");
      }

      options.port = parsePort(argv[index + 1]);
      index += 1;
      continue;
    }

    if (argument === "--server" || argument === "-s") {
      options.server = argv[index + 1];
      index += 1;
      continue;
    }

    if (
      argument === "--subdomain" ||
      argument === "-n" ||
      argument === "--id" ||
      argument === "-i"
    ) {
      if (options.tunnelId) {
        throw new Error(
          "Only one requested subdomain value is allowed per command.",
        );
      }

      options.tunnelId = parseTunnelId(argv[index + 1]);
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
      if (options.port != null) {
        throw new Error("Only one port may be provided per command.");
      }

      options.port = parsePort(argument);
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

function buildTunnelConfig(options) {
  if (options.port == null) {
    throw new Error(
      "You must provide one valid local port with --port <port>.",
    );
  }

  return {
    port: options.port,
    tunnelId: options.tunnelId || createTunnelId(),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const tunnelConfig = buildTunnelConfig(options);
  const client = new TunnelClient({
    serverUrl: options.server,
    host: options.host,
    password: options.password,
    port: tunnelConfig.port,
    tunnelId: tunnelConfig.tunnelId,
    logger: {
      info(message) {
        process.stderr.write(`${message}\n`);
      },
      error(message) {
        process.stderr.write(`${message}\n`);
      },
    },
  });

  const shutdown = () => {
    client.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    const registration = await client.start();
    process.stdout.write(`${registration.publicUrl}\n`);
  } catch (error) {
    client.stop();
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
