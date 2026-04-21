const WebSocket = require("ws");
const {
  decodeBody,
  encodeBody,
  getWebSocketUrl,
  headersFromFetch,
  headersToFetchInit,
  normalizeServerUrl,
} = require("./protocol");

class TunnelClient {
  constructor(options) {
    const {
      serverUrl,
      host = "127.0.0.1",
      port,
      tunnelId,
      logger = console,
    } = options;

    this.serverUrl = normalizeServerUrl(serverUrl);
    this.localBaseUrl = new URL(`http://${host}:${port}`);
    this.tunnelId = tunnelId;
    this.logger = logger;
    this.ws = null;
    this.reconnectTimer = null;
    this.shouldReconnect = false;
    this.readyPromise = null;
    this.readyResolved = false;
    this.resolveReady = null;
    this.rejectReady = null;
  }

  start() {
    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.shouldReconnect = true;
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.connect();
    return this.readyPromise;
  }

  stop() {
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }

  connect() {
    const wsUrl = getWebSocketUrl(this.serverUrl);
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.send({
        type: "register",
        tunnelId: this.tunnelId,
        target: this.localBaseUrl.toString(),
      });
    });

    ws.on("message", (rawMessage) => {
      this.handleMessage(rawMessage).catch((error) => {
        this.logger.error(`Tunnel request handling failed: ${error.message}`);
      });
    });

    ws.on("close", () => {
      if (!this.shouldReconnect) {
        return;
      }

      this.logger.error("Relay connection closed. Retrying in 2 seconds.");
      this.reconnectTimer = setTimeout(() => this.connect(), 2000);
    });

    ws.on("error", (error) => {
      if (!this.readyResolved) {
        this.logger.error(`Relay connection error: ${error.message}`);
      }
    });
  }

  send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("The relay connection is not open.");
    }

    this.ws.send(JSON.stringify(message));
  }

  async handleMessage(rawMessage) {
    const message = JSON.parse(rawMessage.toString());

    if (message.type === "registered") {
      if (!this.readyResolved) {
        this.readyResolved = true;
        this.resolveReady(message);
      } else {
        this.logger.info(`Tunnel reconnected at ${message.publicUrl}`);
      }
      return;
    }

    if (message.type === "proxy_request") {
      await this.handleProxyRequest(message);
      return;
    }

    if (message.type === "error") {
      const error = new Error(message.error || "The relay rejected the tunnel.");
      if (!this.readyResolved && this.rejectReady) {
        this.rejectReady(error);
      }
      this.stop();
      throw error;
    }
  }

  async handleProxyRequest(message) {
    const { requestId, method, path, headers, body } = message;

    try {
      const targetUrl = new URL(path, this.localBaseUrl);
      const requestHeaders = headersToFetchInit(headers);
      delete requestHeaders.host;
      delete requestHeaders["content-length"];
      requestHeaders["accept-encoding"] = "identity";

      const response = await fetch(targetUrl, {
        method,
        headers: requestHeaders,
        body:
          method === "GET" || method === "HEAD" ? undefined : decodeBody(body),
        redirect: "manual",
      });

      const responseBuffer = Buffer.from(await response.arrayBuffer());

      this.send({
        type: "proxy_response",
        requestId,
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: headersFromFetch(response.headers),
        body: encodeBody(responseBuffer),
      });
    } catch (error) {
      this.send({
        type: "proxy_error",
        requestId,
        statusCode: 502,
        error: error.message,
      });
    }
  }
}

module.exports = {
  TunnelClient,
};
