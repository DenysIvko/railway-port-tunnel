#!/usr/bin/env node

const { TunnelClient } = require("../src/client");
const { createTunnelId } = require("../src/protocol");

function printHelp() {
  process.stdout.write(`Usage: railway-tunnel --server <url> --port <port> [options]

Options:
  -p, --port <port>     Local port to expose
  -s, --server <url>    Relay base URL (default: http://127.0.0.1:8080)
  -i, --id <id>         Optional fixed tunnel ID
  -H, --host <host>     Local host to expose (default: 127.0.0.1)
  -h, --help            Show this help
`);
}

function parseArgs(argv) {
  const options = {
    host: "127.0.0.1",
    server: "http://127.0.0.1:8080",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }

    if (argument === "--port" || argument === "-p") {
      options.port = argv[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--server" || argument === "-s") {
      options.server = argv[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--id" || argument === "-i") {
      options.id = argv[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--host" || argument === "-H") {
      options.host = argv[index + 1];
      index += 1;
      continue;
    }

    if (!argument.startsWith("-") && !options.port) {
      options.port = argument;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("You must provide a valid local port with --port <port>.");
  }

  const tunnelId = options.id || createTunnelId();

  const client = new TunnelClient({
    serverUrl: options.server,
    host: options.host,
    port,
    tunnelId,
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

  const registration = await client.start();
  process.stdout.write(`${registration.publicUrl}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
