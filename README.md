# railway-port-tunnel

`railway-port-tunnel` is a small ngrok-style tunnel made of two parts:

- A relay server you deploy to Railway or any Heroku-style Node host
- A CLI you run locally to expose `localhost:<port>` through the relay

The relay gives each client a URL in the form:

```text
https://your-relay-host/t/<tunnel-id>
```

Requests to that URL are proxied through the relay to the local machine running the CLI.

## How it works

1. The CLI opens a WebSocket connection to the relay.
2. The relay assigns or accepts a tunnel ID and prints a public URL.
3. Incoming HTTP requests to `/t/<tunnel-id>` are serialized over WebSocket.
4. The CLI forwards each request to your local server and sends the response back.

This implementation is intentionally simple:

- HTTP request and response bodies are buffered in memory
- Public routing is path-based, not wildcard-subdomain based
- It is designed for development and demos, not as a hardened production tunnel

## Local usage

Install dependencies:

```bash
npm install
```

Start the relay server:

```bash
npm start
```

Start the demo page on `localhost:3500`:

```bash
npm run demo:page
```

Start the tunnel CLI against the local relay:

```bash
npm run tunnel -- --server http://127.0.0.1:8080 --port 3500
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

## CLI usage

```bash
railway-tunnel --server https://your-relay-host --port 3500
```

Options:

- `--port`, `-p`: Local port to expose
- `--server`, `-s`: Relay base URL
- `--id`, `-i`: Optional fixed tunnel ID
- `--host`, `-H`: Local host to forward to, default `127.0.0.1`
- `--help`, `-h`: Show usage

## Deploying the relay to Railway

1. Push this repo to GitHub.
2. Create a new Railway service from the repo.
3. Set the service start command to `npm start` if Railway does not infer it automatically.
4. Set `PUBLIC_BASE_URL` to your deployed relay URL, for example `https://your-app.up.railway.app`.
5. Deploy.

The server also honors the standard platform `PORT` environment variable, so it works on Railway and Heroku-style hosts.

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

- There is no authentication yet.
- Tunnel IDs are guessable unless you supply long custom IDs.
- Large uploads/downloads are buffered rather than streamed.
- WebSocket disconnects trigger reconnect attempts from the CLI, but in-flight requests fail.

For a next iteration, add authentication, wildcard-subdomain routing, TLS termination strategy, streaming, and request logging.
