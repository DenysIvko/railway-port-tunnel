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

function normalizeWildcardBaseDomain(input) {
  if (!input) {
    return null;
  }

  const normalized = String(input)
    .trim()
    .toLowerCase()
    .replace(/^\*\./, "")
    .replace(/\.$/, "");

  if (
    !normalized ||
    normalized.includes("/") ||
    normalized.includes("..") ||
    !/^[a-z0-9.-]+$/.test(normalized)
  ) {
    throw new Error(
      "PUBLIC_WILDCARD_DOMAIN must be a hostname like tunnels.example.com.",
    );
  }

  return normalized;
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

function stripPortFromHost(hostHeader) {
  if (!hostHeader) {
    return null;
  }

  const rawHost = String(hostHeader).trim().toLowerCase();

  if (rawHost.startsWith("[")) {
    const closingBracket = rawHost.indexOf("]");
    if (closingBracket === -1) {
      return rawHost;
    }

    return rawHost.slice(0, closingBracket + 1);
  }

  const colonCount = rawHost.split(":").length - 1;
  if (colonCount === 1) {
    return rawHost.split(":")[0];
  }

  return rawHost;
}

function getHostTunnelId(hostHeader, wildcardBaseDomain) {
  if (!wildcardBaseDomain) {
    return null;
  }

  const normalizedHost = stripPortFromHost(hostHeader);
  if (!normalizedHost) {
    return null;
  }

  const suffix = `.${wildcardBaseDomain}`;
  if (!normalizedHost.endsWith(suffix)) {
    return null;
  }

  const tunnelId = normalizedHost.slice(0, -suffix.length);
  if (!/^[a-zA-Z0-9_-]{4,64}$/.test(tunnelId) || tunnelId.includes(".")) {
    return null;
  }

  return tunnelId;
}

function buildPublicUrl(publicBaseUrl, tunnelId, wildcardBaseDomain) {
  const url = new URL(publicBaseUrl.toString());

  if (wildcardBaseDomain) {
    url.hostname = `${tunnelId}.${wildcardBaseDomain}`;
    url.pathname = "/";
  } else {
    url.pathname = `/t/${tunnelId}`;
  }

  url.search = "";
  url.hash = "";
  return url.toString();
}

function extractTunnelRequest(requestUrl, hostHeader, wildcardBaseDomain) {
  const url = new URL(requestUrl, "http://localhost");
  const hostTunnelId = getHostTunnelId(hostHeader, wildcardBaseDomain);

  if (hostTunnelId) {
    return {
      tunnelId: hostTunnelId,
      forwardPath: `${url.pathname || "/"}${url.search}`,
    };
  }

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
  buildPublicUrl,
  createTunnelId,
  decodeBody,
  encodeBody,
  extractTunnelRequest,
  getWebSocketUrl,
  getHostTunnelId,
  headersFromFetch,
  headersToFetchInit,
  normalizeHeaders,
  normalizeServerUrl,
  normalizeWildcardBaseDomain,
  stripPortFromHost,
};
