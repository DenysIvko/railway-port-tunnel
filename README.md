# railway-port-tunnel

`railway-port-tunnel` is a small ngrok-style tunnel made of two parts:

- A relay server you deploy to Railway or any Heroku-style Node host
- A CLI you run locally to expose `localhost:<port>` through the relay

In this repo:

- The Railway-facing proxy service is [server/index.js](/Users/fk/vscode/tunnel/server/index.js)
- The local CLI is [bin/railway-tunnel.js](/Users/fk/vscode/tunnel/bin/railway-tunnel.js)
- Railway deployment config is [railway.json](/Users/fk/vscode/tunnel/railway.json)

The relay gives each client a URL in the form:

```text
https://your-relay-host/t/<tunnel-id>
```

If you configure a wildcard custom domain, the relay can also generate host-based URLs:

```text
https://<tunnel-id>.tunnels.example.com
```

Requests to that URL are proxied through the relay to the local machine running the CLI.

## How it works

1. The CLI opens a WebSocket connection to the relay.
2. The relay assigns or accepts a tunnel ID and prints a public URL.
3. Incoming HTTP requests to `/t/<tunnel-id>` or the matching tunnel subdomain are serialized over WebSocket.
4. The CLI forwards each request to your local server and sends the response back.

This implementation now supports multiple simultaneous tunnels from one CLI process by repeating `--port`.

This implementation is intentionally simple:

- HTTP request and response bodies are buffered in memory
- Railway's free `*.up.railway.app` domain uses path-based routing
- Host-based subdomain routing is available when you configure a wildcard custom domain
- It is designed for development and demos, not as a hardened production tunnel

## Local usage

Install dependencies:

```bash
npm install
```

Expose a local port through the live Railway relay:

```bash
npx railway-port-tunnel --pass 31415 --port 3500
```

Expose multiple ports at once:

```bash
npx railway-port-tunnel --pass 31415 --port 3000:app --port 3500:admin
```

That prints one URL per exposed port and keeps both tunnels alive in the same process.

The CLI now defaults to the deployed relay:

```text
https://relay-production-55c2.up.railway.app
```

Override it with `--server` or the `RAILWAY_TUNNEL_SERVER_URL` environment variable when needed.
Set the shared secret with `--pass` or `RAILWAY_TUNNEL_PASSWORD`.

Start the relay server:

```bash
npm start
```

Or start the relay plus demo page together:

```bash
npm run demo:stack
```

Start the demo page on `localhost:3500`:

```bash
npm run demo:page
```

Start the tunnel CLI against the local relay:

```bash
npm run tunnel -- --server http://127.0.0.1:8080 --pass 31415 --port 3500
```

Or expose two ports together:

```bash
npm run tunnel -- --server http://127.0.0.1:8080 --pass 31415 --port 3000:app --port 3500:admin
```

The command prints a URL like:

```text
http://127.0.0.1:8080/t/abc123xyz789
```

Open that URL in a browser or `curl` it, and you should see the demo page served from your local machine.

## End-to-end verification

Run the automated local test:

```bash
npm run test:e2e
```

This starts the relay, the demo page, the CLI, fetches the public tunnel URL, and verifies that the proxied HTML response comes back successfully.
It also verifies multi-port routing and local host-based routing with a wildcard suffix.

## CLI usage

```bash
railway-tunnel --server https://your-relay-host --port 3500
```

Options:

- `--port`, `-p`: Local port to expose. Repeat it to expose multiple ports. Supports `<port:id>` syntax.
- `--server`, `-s`: Relay base URL
- `--id`, `-i`: Optional fixed tunnel ID. For multi-port usage, prefer inline `<port:id>`.
- `--pass`, `-P`: Shared tunnel password used during registration
- `--host`, `-H`: Local host to forward to, default `127.0.0.1`
- `--help`, `-h`: Show usage

## Deploying the relay to Railway

This repo now includes [railway.json](/Users/fk/vscode/tunnel/railway.json), which sets:

- Start command: `npm start`
- Healthcheck: `/health`

Deployment steps:

1. Push this repo to GitHub.
2. In Railway, create a new service from that repo.
3. Deploy it.
4. In Railway service settings, generate a public domain.
5. Set `PUBLIC_BASE_URL` to that generated domain, for example `https://your-app.up.railway.app`.
6. Set `TUNNEL_PASSWORD` to your shared secret, for example `31415`.
7. Redeploy so the tunnel URLs use the final public base URL and enforce registration auth.

For host-based subdomain URLs on Railway:

1. Add a wildcard custom domain such as `*.tunnels.example.com` to the relay service.
2. Set `PUBLIC_WILDCARD_DOMAIN=tunnels.example.com`.
3. Redeploy.

Without a wildcard custom domain, the relay still supports multiple simultaneous tunnels using distinct path URLs on the single Railway service domain.

The server also honors the standard platform `PORT` environment variable, so it works on Railway and Heroku-style hosts.

Example local env values are in [.env.example](/Users/fk/vscode/tunnel/.env.example).

## Publishing the CLI to npm

Before publishing, confirm the package name in `package.json` is available or rename it.

Then publish:

```bash
npm publish --access public
```

Users can then run:

```bash
npx railway-port-tunnel --server https://your-relay-host --port 3500
```

## Security and limitations

- Registration authentication is a single shared secret and is not user-specific.
- Public tunneled traffic is not separately authenticated once a tunnel is registered.
- Tunnel IDs are guessable unless you supply long custom IDs.
- Large uploads/downloads are buffered rather than streamed.
- WebSocket disconnects trigger reconnect attempts from the CLI, but in-flight requests fail.

For a next iteration, add authentication, wildcard-subdomain routing, TLS termination strategy, streaming, and request logging.
