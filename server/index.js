const http = require("node:http");
const { randomUUID } = require("node:crypto");
const WebSocket = require("ws");
const {
  applyHeaders,
  decodeBody,
  encodeBody,
  extractTunnelRequest,
  normalizeHeaders,
} = require("../src/protocol");

const { WebSocketServer } = WebSocket;

const port = Number(process.env.PORT || 8080);
const publicBaseUrl =
  process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${port}`;
const maxBodySize = 10 * 1024 * 1024;
const tunnelSockets = new Map();
const pendingResponses = new Map();

function sendJson(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) {
    throw new Error("Tunnel socket is not connected.");
  }

  ws.send(JSON.stringify(payload));
}

function sendJsonResponse(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload, null, 2));
}

function sendTextResponse(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(body);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;

    request.on("data", (chunk) => {
      totalLength += chunk.length;
      if (totalLength > maxBodySize) {
        reject(new Error("The request body exceeded the 10 MB limit."));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    request.on("error", reject);
  });
}

function releasePendingRequestsForSocket(ws, error) {
  for (const [requestId, pending] of pendingResponses.entries()) {
    if (pending.ws !== ws) {
      continue;
    }

    clearTimeout(pending.timeout);
    pendingResponses.delete(requestId);
    pending.reject(error);
  }
}

const server = http.createServer(async (request, response) => {
  if (request.url === "/health") {
    sendJsonResponse(response, 200, { status: "ok" });
    return;
  }

  if (request.url === "/" || request.url === "") {
    sendJsonResponse(response, 200, {
      status: "ok",
      usage: "Connect the CLI, then open /t/<tunnel-id>.",
      publicBaseUrl,
      connectedTunnels: tunnelSockets.size,
    });
    return;
  }

  const tunnelRequest = extractTunnelRequest(request.url);
  if (!tunnelRequest) {
    sendTextResponse(
      response,
      404,
      "Unknown route. Use /t/<tunnel-id> after a tunnel is registered.",
    );
    return;
  }

  const ws = tunnelSockets.get(tunnelRequest.tunnelId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    sendTextResponse(response, 404, "Tunnel not connected.");
    return;
  }

  try {
    const requestBody = await readRequestBody(request);
    const requestId = randomUUID();
    const forwardedHeaders = normalizeHeaders(request.headers, {
      dropHost: true,
      forceIdentityEncoding: true,
    });

    forwardedHeaders["x-forwarded-host"] = request.headers.host || "";
    forwardedHeaders["x-forwarded-proto"] = request.socket.encrypted
      ? "https"
      : "http";
    forwardedHeaders["x-forwarded-for"] = request.socket.remoteAddress || "";
    forwardedHeaders["x-tunnel-id"] = tunnelRequest.tunnelId;

    const tunnelResponse = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingResponses.delete(requestId);
        reject(new Error("Tunnel request timed out after 30 seconds."));
      }, 30_000);

      pendingResponses.set(requestId, { ws, timeout, resolve, reject });

      try {
        sendJson(ws, {
          type: "proxy_request",
          requestId,
          method: request.method || "GET",
          path: tunnelRequest.forwardPath,
          headers: forwardedHeaders,
          body: encodeBody(requestBody),
        });
      } catch (error) {
        clearTimeout(timeout);
        pendingResponses.delete(requestId);
        reject(error);
      }
    });

    response.statusCode = tunnelResponse.statusCode || 200;
    if (tunnelResponse.statusMessage) {
      response.statusMessage = tunnelResponse.statusMessage;
    }

    applyHeaders(response, normalizeHeaders(tunnelResponse.headers));
    response.end(decodeBody(tunnelResponse.body));
  } catch (error) {
    const statusCode = error.message.includes("timed out") ? 504 : 502;
    sendTextResponse(response, statusCode, error.message);
  }
});

const wsServer = new WebSocketServer({ server, path: "/ws" });

wsServer.on("connection", (ws) => {
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (rawMessage) => {
    let message;

    try {
      message = JSON.parse(rawMessage.toString());
    } catch (error) {
      sendJson(ws, { type: "error", error: "Invalid JSON message." });
      ws.close();
      return;
    }

    if (message.type === "register") {
      const tunnelId = String(message.tunnelId || "").trim();
      if (!/^[a-zA-Z0-9_-]{4,64}$/.test(tunnelId)) {
        sendJson(ws, {
          type: "error",
          error: "Tunnel IDs must be 4-64 characters using letters, numbers, _ or -.",
        });
        ws.close();
        return;
      }

      const existingSocket = tunnelSockets.get(tunnelId);
      if (
        existingSocket &&
        existingSocket !== ws &&
        existingSocket.readyState === WebSocket.OPEN
      ) {
        sendJson(ws, {
          type: "error",
          error: `Tunnel ID "${tunnelId}" is already in use.`,
        });
        ws.close();
        return;
      }

      ws.tunnelId = tunnelId;
      tunnelSockets.set(tunnelId, ws);

      sendJson(ws, {
        type: "registered",
        tunnelId,
        publicUrl: new URL(`/t/${tunnelId}`, publicBaseUrl).toString(),
      });
      return;
    }

    if (message.type === "proxy_response") {
      const pending = pendingResponses.get(message.requestId);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeout);
      pendingResponses.delete(message.requestId);
      pending.resolve(message);
      return;
    }

    if (message.type === "proxy_error") {
      const pending = pendingResponses.get(message.requestId);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeout);
      pendingResponses.delete(message.requestId);
      pending.reject(
        new Error(message.error || "The tunnel client failed the request."),
      );
    }
  });

  ws.on("close", () => {
    if (ws.tunnelId && tunnelSockets.get(ws.tunnelId) === ws) {
      tunnelSockets.delete(ws.tunnelId);
    }

    releasePendingRequestsForSocket(ws, new Error("Tunnel client disconnected."));
  });
});

const pingInterval = setInterval(() => {
  for (const ws of wsServer.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }

    ws.isAlive = false;
    ws.ping();
  }
}, 15_000);

server.on("error", (error) => {
  process.stderr.write(`Relay failed to start: ${error.message}\n`);
  process.exit(1);
});

wsServer.on("error", (error) => {
  process.stderr.write(`WebSocket server error: ${error.message}\n`);
});

server.on("close", () => {
  clearInterval(pingInterval);
});

server.listen(port, () => {
  process.stdout.write(
    `Relay listening on ${publicBaseUrl} and accepting WebSocket clients on /ws\n`,
  );
});
