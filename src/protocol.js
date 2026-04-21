const { randomBytes } = require("node:crypto");

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function createTunnelId() {
  return randomBytes(9)
    .toString("base64url")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase()
    .slice(0, 12);
}

function normalizeServerUrl(input) {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The relay URL must start with http:// or https://");
  }

  if (url.pathname === "") {
    url.pathname = "/";
  }

  return url;
}

function getWebSocketUrl(serverUrl) {
  const url = new URL(serverUrl.toString());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  return url;
}

function encodeBody(buffer) {
  return buffer && buffer.length > 0 ? buffer.toString("base64") : null;
}

function decodeBody(encodedBody) {
  return encodedBody ? Buffer.from(encodedBody, "base64") : Buffer.alloc(0);
}

function normalizeHeaders(headers, options = {}) {
  const { dropHost = false, forceIdentityEncoding = false } = options;
  const normalized = {};

  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    if (rawValue == null) {
      continue;
    }

    const name = rawName.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name)) {
      continue;
    }

    if (dropHost && name === "host") {
      continue;
    }

    if (forceIdentityEncoding && name === "accept-encoding") {
      normalized[name] = "identity";
      continue;
    }

    normalized[name] = Array.isArray(rawValue)
      ? rawValue.map((value) => String(value))
      : String(rawValue);
  }

  if (forceIdentityEncoding && !normalized["accept-encoding"]) {
    normalized["accept-encoding"] = "identity";
  }

  return normalized;
}

function headersToFetchInit(headers) {
  const flattened = {};

  for (const [name, value] of Object.entries(headers || {})) {
    flattened[name] = Array.isArray(value) ? value.join(", ") : value;
  }

  return flattened;
}

function headersFromFetch(headers) {
  const collected = {};
  for (const [name, value] of headers.entries()) {
    collected[name] = value;
  }

  if (typeof headers.getSetCookie === "function") {
    const setCookies = headers.getSetCookie();
    if (setCookies.length > 0) {
      collected["set-cookie"] = setCookies;
    }
  }

  return normalizeHeaders(collected);
}

function applyHeaders(response, headers) {
  for (const [name, value] of Object.entries(headers || {})) {
    response.setHeader(name, value);
  }
}

function extractTunnelRequest(requestUrl) {
  const url = new URL(requestUrl, "http://localhost");
  const match = url.pathname.match(/^\/t\/([^/]+)(\/.*)?$/);

  if (!match) {
    return null;
  }

  return {
    tunnelId: match[1],
    forwardPath: `${match[2] || "/"}${url.search}`,
  };
}

module.exports = {
  applyHeaders,
  createTunnelId,
  decodeBody,
  encodeBody,
  extractTunnelRequest,
  getWebSocketUrl,
  headersFromFetch,
  headersToFetchInit,
  normalizeHeaders,
  normalizeServerUrl,
};
