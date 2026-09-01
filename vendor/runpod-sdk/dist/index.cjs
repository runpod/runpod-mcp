"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  DEFAULT_BASE_URL: () => DEFAULT_BASE_URL,
  createRetryFetch: () => createRetryFetch,
  createRunpodClient: () => createRunpodClient,
  parseRetryAfter: () => parseRetryAfter
});
module.exports = __toCommonJS(index_exports);
var import_openapi_fetch = __toESM(require("openapi-fetch"), 1);

// src/retry.ts
var DEFAULTS = {
  maxAttempts: 4,
  minBackoffMs: 1e3,
  maxBackoffMs: 3e4,
  maxRetryAfterMs: 6e4
};
var IDEMPOTENT_METHODS = /* @__PURE__ */ new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);
var RETRYABLE_STATUS = /* @__PURE__ */ new Set([500, 502, 503, 504]);
function isAbortError(error) {
  const name = error?.name;
  return name === "AbortError" || name === "TimeoutError";
}
function parseRetryAfter(header) {
  if (!header) return void 0;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1e3;
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(date - Date.now(), 0);
  return void 0;
}
function shouldRetry(method, response) {
  const idempotent = IDEMPOTENT_METHODS.has(method);
  if (response === void 0) return idempotent;
  if (response.status === 429) return true;
  return idempotent && RETRYABLE_STATUS.has(response.status);
}
function createRetryFetch(options = {}) {
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  const minBackoffMs = options.minBackoffMs ?? DEFAULTS.minBackoffMs;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULTS.maxRetryAfterMs;
  const baseFetch = options.fetch ?? globalThis.fetch;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return async (input, init) => {
    const original = new Request(input, init);
    for (let attempt = 1; ; attempt++) {
      let response;
      let networkError;
      try {
        response = await baseFetch(original.clone());
      } catch (error) {
        if (isAbortError(error)) throw error;
        networkError = error;
      }
      if (response !== void 0 && !shouldRetry(original.method, response)) return response;
      if (response === void 0 && !shouldRetry(original.method, void 0)) throw networkError;
      if (attempt >= maxAttempts) {
        if (response !== void 0) return response;
        throw networkError;
      }
      let delay = parseRetryAfter(response?.headers.get("Retry-After") ?? null);
      if (delay !== void 0) {
        delay = Math.min(delay, maxRetryAfterMs);
      } else {
        const shift = Math.min(attempt - 1, 20);
        const backoff = Math.min(minBackoffMs * 2 ** shift, maxBackoffMs);
        delay = backoff / 2 + random() * (backoff / 2);
      }
      await response?.body?.cancel();
      await sleep(delay);
    }
  };
}

// src/index.ts
var DEFAULT_BASE_URL = "https://api.runpod.io";
function createRunpodClient(options = {}) {
  const apiKey = options.apiKey ?? process.env.RUNPOD_API_KEY;
  if (!apiKey) {
    throw new Error("runpod: API key required (set RUNPOD_API_KEY or pass apiKey)");
  }
  const baseUrl = options.baseUrl?.trim() || process.env.RUNPOD_API_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const baseFetch = options.fetch ?? globalThis.fetch;
  const fetchImpl = options.retry === false ? baseFetch : createRetryFetch({ ...options.retry, fetch: baseFetch });
  return (0, import_openapi_fetch.default)({
    baseUrl,
    fetch: fetchImpl,
    headers: { Authorization: `Bearer ${apiKey}` }
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_BASE_URL,
  createRetryFetch,
  createRunpodClient,
  parseRetryAfter
});
