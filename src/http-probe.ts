import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { createRedactionPlan, type RedactionPlan, redactText } from "./redact.js";
import { createStreamInspector } from "./stream-parser.js";
import type {
  DocumentSignals,
  HeaderSnapshot,
  ProbeCompletion,
  ProbeOptions,
  ProbeResult,
  ProbeTimings,
  RedirectHop,
} from "./types.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SNAPSHOT_HEADERS = Object.freeze([
  "age",
  "cache-control",
  "cf-cache-status",
  "content-encoding",
  "content-language",
  "content-length",
  "content-type",
  "date",
  "etag",
  "expires",
  "last-modified",
  "server",
  "vary",
  "x-cache",
  "x-cache-hits",
  "x-nextjs-cache",
  "x-powered-by",
  "x-vercel-cache",
] as const);

interface FinalizeOptions {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly probe: ProbeOptions;
  readonly redirects: readonly RedirectHop[];
  readonly headers: HeaderSnapshot;
  readonly timings: ProbeTimings;
  readonly bytesRead: number;
  readonly signals: DocumentSignals;
  readonly completion: ProbeCompletion;
  readonly status?: number;
  readonly bodySha256?: string;
  readonly error?: string;
}

function emptySignals(): DocumentSignals {
  return {
    descriptions: [],
    canonicals: [],
    robots: [],
    h1s: [],
    jsonLd: [],
  };
}

function emptyHeaders(): HeaderSnapshot {
  return { values: {}, setCookiePresent: false };
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

function snapshotHeaders(headers: Headers, redaction: RedactionPlan): HeaderSnapshot {
  const values: Record<string, string> = {};
  for (const name of SNAPSHOT_HEADERS) {
    const value = headers.get(name);
    if (value !== null) values[name] = redactText(value, redaction);
  }
  return {
    values,
    setCookiePresent: headers.has("set-cookie"),
  };
}

function redactSignals(signals: DocumentSignals, redaction: RedactionPlan): DocumentSignals {
  const element = <Signal extends { readonly value: string }>(signal: Signal): Signal => ({
    ...signal,
    value: redactText(signal.value, redaction),
  });
  return {
    ...(signals.title === undefined ? {} : { title: element(signals.title) }),
    ...(signals.titles === undefined ? {} : { titles: signals.titles.map(element) }),
    descriptions: signals.descriptions.map(element),
    canonicals: signals.canonicals.map(element),
    robots: signals.robots.map(element),
    h1s: signals.h1s.map(element),
    ...(signals.firstMainText === undefined
      ? {}
      : { firstMainText: element(signals.firstMainText) }),
    jsonLd: signals.jsonLd.map((signal) => ({
      ...signal,
      types: signal.types.map((type) => redactText(type, redaction)),
      ...(signal.error === undefined ? {} : { error: redactText(signal.error, redaction) }),
    })),
    ...(signals.headClosed === undefined ? {} : { headClosed: signals.headClosed }),
    ...(signals.bodyStarted === undefined ? {} : { bodyStarted: signals.bodyStarted }),
    ...(signals.documentClosed === undefined ? {} : { documentClosed: signals.documentClosed }),
  };
}

function finalize(options: FinalizeOptions): ProbeResult {
  return {
    requestedUrl: options.requestedUrl,
    finalUrl: options.finalUrl,
    agent: options.probe.agent,
    ...(options.status === undefined ? {} : { status: options.status }),
    redirects: options.redirects,
    headers: options.headers,
    timings: options.timings,
    bytesRead: options.bytesRead,
    ...(options.bodySha256 === undefined ? {} : { bodySha256: options.bodySha256 }),
    signals: options.signals,
    completion: options.completion,
    ...(options.error === undefined ? {} : { error: options.error }),
  };
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function safeUrlForReport(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return "[invalid URL]";
  }
}

function isHtmlContentType(value: string | null): boolean {
  if (value === null || value.trim().length === 0) return false;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

function createRequestHeaders(
  agentUserAgent: string,
  customHeaders: Headers,
  includeCustom: boolean,
): Headers {
  const headers = includeCustom ? new Headers(customHeaders) : new Headers();
  if (!headers.has("accept")) {
    headers.set("accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8");
  }
  headers.set("accept-encoding", "identity");
  headers.set("user-agent", agentUserAgent);
  return headers;
}

function validateLimits(options: ProbeOptions): string | undefined {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return "timeoutMs must be greater than zero.";
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    return "maxBytes must be a positive safe integer.";
  }
  if (!Number.isSafeInteger(options.maxRedirects) || options.maxRedirects < 0) {
    return "maxRedirects must be a non-negative safe integer.";
  }
  return undefined;
}

/**
 * Read one URL exactly as an HTTP crawler would: no browser, no hydration, and redirects handled
 * explicitly so caller-supplied headers cannot cross an origin boundary.
 */
export async function probeUrl(options: ProbeOptions): Promise<ProbeResult> {
  const startedAt = performance.now();
  const requestedUrl = safeUrlForReport(options.url);
  const initialUrl = parseHttpUrl(options.url);
  const limitError = validateLimits(options);
  if (initialUrl === undefined || limitError !== undefined) {
    return finalize({
      requestedUrl,
      finalUrl: requestedUrl,
      probe: options,
      redirects: [],
      headers: emptyHeaders(),
      timings: { headersMs: elapsedSince(startedAt) },
      bytesRead: 0,
      signals: emptySignals(),
      completion: "invalid-response",
      error:
        initialUrl === undefined
          ? "URL must use http:// or https:// and cannot contain embedded credentials."
          : (limitError ?? "Probe options are invalid."),
    });
  }

  let customHeaders: Headers;
  try {
    customHeaders = new Headers(options.headers);
  } catch {
    return finalize({
      requestedUrl,
      finalUrl: initialUrl.href,
      probe: options,
      redirects: [],
      headers: emptyHeaders(),
      timings: { headersMs: elapsedSince(startedAt) },
      bytesRead: 0,
      signals: emptySignals(),
      completion: "invalid-response",
      error: "One or more custom request headers are invalid.",
    });
  }

  const redaction = createRedactionPlan(
    options.redactHeaderValues === false
      ? []
      : [...customHeaders.values()].filter((value) => value.length > 0),
  );
  const redirects: RedirectHop[] = [];
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  let currentUrl = initialUrl;
  let includeCustomHeaders = true;
  let lastHeaders = emptyHeaders();
  try {
    while (true) {
      const hopStartedAt = performance.now();
      let response: Response;
      try {
        response = await fetch(currentUrl, {
          method: "GET",
          headers: createRequestHeaders(
            options.agent.userAgent,
            customHeaders,
            includeCustomHeaders,
          ),
          redirect: "manual",
          signal: controller.signal,
        });
      } catch {
        return finalize({
          requestedUrl,
          finalUrl: redactText(currentUrl.href, redaction),
          probe: options,
          redirects,
          headers: lastHeaders,
          timings: { headersMs: elapsedSince(startedAt) },
          bytesRead: 0,
          signals: emptySignals(),
          completion: timedOut ? "timeout" : "network-error",
          error: timedOut ? "Request timed out." : "Network request failed.",
        });
      }

      lastHeaders = snapshotHeaders(response.headers, redaction);
      const responseDurationMs = elapsedSince(hopStartedAt);

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        if (location === null || location.trim().length === 0) {
          await response.body?.cancel().catch(() => undefined);
          return finalize({
            requestedUrl,
            finalUrl: redactText(currentUrl.href, redaction),
            probe: options,
            redirects,
            headers: lastHeaders,
            timings: { headersMs: elapsedSince(startedAt) },
            bytesRead: 0,
            signals: emptySignals(),
            completion: "invalid-response",
            status: response.status,
            error: "Redirect response did not include a Location header.",
          });
        }

        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          await response.body?.cancel().catch(() => undefined);
          return finalize({
            requestedUrl,
            finalUrl: redactText(currentUrl.href, redaction),
            probe: options,
            redirects,
            headers: lastHeaders,
            timings: { headersMs: elapsedSince(startedAt) },
            bytesRead: 0,
            signals: emptySignals(),
            completion: "invalid-response",
            status: response.status,
            error: "Redirect response included an invalid Location header.",
          });
        }

        if (
          (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") ||
          nextUrl.username.length > 0 ||
          nextUrl.password.length > 0
        ) {
          await response.body?.cancel().catch(() => undefined);
          return finalize({
            requestedUrl,
            finalUrl: redactText(currentUrl.href, redaction),
            probe: options,
            redirects,
            headers: lastHeaders,
            timings: { headersMs: elapsedSince(startedAt) },
            bytesRead: 0,
            signals: emptySignals(),
            completion: "invalid-response",
            status: response.status,
            error:
              nextUrl.username.length > 0 || nextUrl.password.length > 0
                ? "Redirect target cannot contain embedded credentials."
                : "Redirect target must use http:// or https://.",
          });
        }

        redirects.push({
          url: redactText(currentUrl.href, redaction),
          status: response.status,
          location: redactText(nextUrl.href, redaction),
          durationMs: responseDurationMs,
        });
        await response.body?.cancel().catch(() => undefined);

        if (redirects.length > options.maxRedirects) {
          return finalize({
            requestedUrl,
            finalUrl: redactText(currentUrl.href, redaction),
            probe: options,
            redirects,
            headers: lastHeaders,
            timings: { headersMs: elapsedSince(startedAt) },
            bytesRead: 0,
            signals: emptySignals(),
            completion: "invalid-response",
            status: response.status,
            error: `Redirect limit of ${options.maxRedirects} exceeded.`,
          });
        }

        if (nextUrl.origin !== currentUrl.origin) includeCustomHeaders = false;
        currentUrl = nextUrl;
        continue;
      }

      const headersMs = elapsedSince(startedAt);
      const contentType = response.headers.get("content-type");
      if (!isHtmlContentType(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        const mediaType = contentType?.split(";", 1)[0]?.trim();
        return finalize({
          requestedUrl,
          finalUrl: redactText(currentUrl.href, redaction),
          probe: options,
          redirects,
          headers: lastHeaders,
          timings: { headersMs },
          bytesRead: 0,
          signals: emptySignals(),
          completion: "invalid-response",
          status: response.status,
          error:
            mediaType === undefined
              ? "Expected an HTML response but the Content-Type header was missing."
              : `Expected an HTML response but received Content-Type ${redactText(mediaType, redaction).slice(0, 160)}.`,
        });
      }
      const inspector = createStreamInspector();
      const hash = createHash("sha256");
      let bytesRead = 0;
      let firstByteMs: number | undefined;
      let completion: ProbeCompletion = "complete";
      let error: string | undefined;

      if (response.body !== null) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const read = await reader.read();
            if (read.done) break;
            if (read.value.byteLength === 0) continue;
            if (firstByteMs === undefined) firstByteMs = elapsedSince(startedAt);

            const available = options.maxBytes - bytesRead;
            if (read.value.byteLength > available) {
              if (available > 0) {
                const prefix = read.value.subarray(0, available);
                bytesRead += prefix.byteLength;
                hash.update(prefix);
                inspector.write(prefix, elapsedSince(startedAt));
              }
              completion = "max-bytes-exceeded";
              error = `Response exceeded the ${options.maxBytes} byte limit.`;
              await reader.cancel().catch(() => undefined);
              break;
            }

            bytesRead += read.value.byteLength;
            hash.update(read.value);
            inspector.write(read.value, elapsedSince(startedAt));
          }
        } catch {
          completion = timedOut ? "timeout" : "network-error";
          error = timedOut ? "Request timed out." : "Response stream failed.";
        } finally {
          reader.releaseLock();
        }
      }

      const completedAt = elapsedSince(startedAt);
      const signals = redactSignals(inspector.end(completedAt), redaction);
      const timings: ProbeTimings = {
        headersMs,
        ...(firstByteMs === undefined ? {} : { firstByteMs }),
        ...(completion === "complete" ? { completeMs: completedAt } : {}),
      };
      return finalize({
        requestedUrl,
        finalUrl: redactText(currentUrl.href, redaction),
        probe: options,
        redirects,
        headers: lastHeaders,
        timings,
        bytesRead,
        bodySha256: hash.digest("hex"),
        signals,
        completion,
        status: response.status,
        ...(error === undefined ? {} : { error }),
      });
    }
  } finally {
    clearTimeout(timeout);
  }
}
