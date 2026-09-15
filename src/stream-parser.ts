import { Parser } from "htmlparser2";

import { isSocialMetadataProperty } from "./social.js";

import type {
  DocumentSignals,
  ElementLocation,
  ElementSignal,
  JsonLdSignal,
  RobotsAudience,
  RobotsSignal,
  SocialMetadataProperty,
  SocialMetadataSignal,
  TimingMark,
} from "./types.js";

const ELEMENT_VALUE_LIMIT = 4_096;
const MAIN_TEXT_LIMIT = 240;
const SIGNAL_LIMIT = 256;
const JSON_LD_BLOCK_LIMIT = 64;
const JSON_LD_CAPTURE_LIMIT = 1_048_576;
const JSON_LD_NODE_LIMIT = 10_000;
const JSON_LD_TYPE_LIMIT = 256;

/**
 * Bytes inspected while waiting for an in-document encoding declaration. A response charset only
 * needs the first three bytes checked for a BOM before decoding can begin.
 */
const CHARSET_SNIFF_LIMIT = 1_024;

interface TextCapture {
  readonly location: ElementLocation;
  value: string;
}

interface ScriptCapture extends TextCapture {
  readonly jsonLd: boolean;
  bytes: number;
  truncated: boolean;
  omitted: boolean;
}

interface PendingChunk {
  readonly chunk: Uint8Array;
  readonly atMs: number;
}

export interface StreamInspectorOptions {
  /** Encoding label declared by the response, applied before any in-document declaration. */
  readonly charset?: string;
}

export interface StreamInspector {
  readonly bytesObserved: number;
  write(chunk: Uint8Array, atMs: number): void;
  end(atMs?: number): DocumentSignals;
  finish(atMs?: number): DocumentSignals;
}

function normalizedText(value: string, limit = ELEMENT_VALUE_LIMIT): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, limit);
}

function timing(atMs: number, observedByByte: number): TimingMark {
  return {
    atMs: Number.isFinite(atMs) ? Math.max(0, atMs) : 0,
    observedByByte,
  };
}

function isRobotsAudience(value: string | undefined): value is RobotsAudience {
  return value === "robots" || value === "googlebot" || value === "bingbot";
}

function bomCharset(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  return undefined;
}

/** Normalize a declared label and confirm that the runtime can actually decode it. */
function supportedCharset(label: string | undefined): string | undefined {
  const trimmed =
    label
      ?.trim()
      .replace(/^["']|["']$/gu, "")
      .toLowerCase() ?? "";
  if (trimmed.length === 0) return undefined;
  try {
    return new TextDecoder(trimmed).encoding;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort ASCII scan for a declaration carried by the document itself. Encoding labels are
 * ASCII, so replacing high bytes keeps the scan a single byte wide.
 */
function declaredCharset(bytes: Uint8Array): string | undefined {
  let ascii = "";
  for (const byte of bytes) {
    ascii += byte < 0x80 ? String.fromCharCode(byte) : " ";
  }
  let charset: string | undefined;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name !== "meta" || charset !== undefined) return;
        const { charset: declared, content, "http-equiv": pragma } = attributes;
        let label = declared;
        if (label === undefined && pragma?.toLowerCase() === "content-type") {
          const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/iu.exec(
            content ?? "",
          );
          label = match?.[1] ?? match?.[2] ?? match?.[3];
        }
        charset = supportedCharset(label);
        // An ASCII meta declaration cannot itself announce a UTF-16 byte stream.
        if (charset === "utf-16le" || charset === "utf-16be") charset = "utf-8";
      },
    },
    { decodeEntities: false },
  );
  // Only complete tags qualify. Comments, script text and unrelated attributes are ignored.
  parser.write(ascii);
  return charset;
}

function bufferedPrefix(pending: readonly PendingChunk[]): Uint8Array {
  let total = 0;
  for (const item of pending) {
    total = Math.min(CHARSET_SNIFF_LIMIT, total + item.chunk.byteLength);
  }

  const prefix = new Uint8Array(total);
  let offset = 0;
  for (const item of pending) {
    if (offset >= total) break;
    const slice = item.chunk.subarray(0, total - offset);
    prefix.set(slice, offset);
    offset += slice.byteLength;
  }
  return prefix;
}

function collectJsonLdTypes(value: unknown, output: Set<string>): void {
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0 && visited < JSON_LD_NODE_LIMIT) {
    const current = pending.pop();
    visited += 1;
    if (Array.isArray(current)) {
      for (const entry of current) {
        if (pending.length + visited >= JSON_LD_NODE_LIMIT) break;
        pending.push(entry);
      }
      continue;
    }
    if (typeof current !== "object" || current === null) continue;

    const object = current as Readonly<Record<string, unknown>>;
    const type = object["@type"];
    if (typeof type === "string" && type.trim().length > 0) {
      if (output.size < JSON_LD_TYPE_LIMIT) output.add(type.trim().slice(0, ELEMENT_VALUE_LIMIT));
    } else if (Array.isArray(type)) {
      for (const entry of type) {
        if (output.size >= JSON_LD_TYPE_LIMIT) break;
        if (typeof entry === "string" && entry.trim().length > 0) {
          output.add(entry.trim().slice(0, ELEMENT_VALUE_LIMIT));
        }
      }
    }

    for (const key of Object.keys(object)) {
      if (pending.length + visited >= JSON_LD_NODE_LIMIT) break;
      pending.push(object[key]);
    }
  }
}

class HtmlStreamInspector implements StreamInspector {
  readonly #charset: string | undefined;
  #decoder: TextDecoder | undefined;
  readonly #parser: Parser;
  readonly #descriptions: ElementSignal[] = [];
  readonly #canonicals: ElementSignal[] = [];
  readonly #robots: RobotsSignal[] = [];
  readonly #socialMetadata: SocialMetadataSignal[] = [];
  readonly #socialMetadataCounts = new Map<SocialMetadataProperty, number>();
  readonly #h1s: ElementSignal[] = [];
  readonly #jsonLd: JsonLdSignal[] = [];
  readonly #titles: ElementSignal[] = [];
  #pending: PendingChunk[] = [];
  #pendingBytes = 0;

  #bytesObserved = 0;
  #currentAtMs = 0;
  #ended = false;
  #result?: DocumentSignals;
  #inHead = false;
  #inBody = false;
  #templateDepth = 0;
  #foreignContentDepth = 0;
  #mainDepth = 0;
  #ignoredMainTextDepth = 0;
  #titleCapture: TextCapture | undefined;
  #h1Capture: TextCapture | undefined;
  #scriptCapture: ScriptCapture | undefined;
  #jsonLdLimitReported = false;
  #mainText = "";
  #mainTextStarted?: TimingMark;
  #mainTextLocation: ElementLocation = "document";
  #headClosed?: TimingMark;
  #bodyStarted?: TimingMark;
  #documentClosed?: TimingMark;

  constructor(charset?: string) {
    this.#charset = supportedCharset(charset);
    this.#parser = new Parser(
      {
        onopentag: (name, attributes) => this.#onOpenTag(name, attributes),
        ontext: (value) => this.#onText(value),
        onclosetag: (name, isImplied) => this.#onCloseTag(name, isImplied),
      },
      {
        decodeEntities: true,
        lowerCaseAttributeNames: true,
        lowerCaseTags: true,
        recognizeCDATA: true,
      },
    );
  }

  get bytesObserved(): number {
    return this.#bytesObserved + this.#pendingBytes;
  }

  write(chunk: Uint8Array, atMs: number): void {
    if (this.#ended) throw new Error("Cannot write to a finished stream inspector.");
    if (chunk.byteLength === 0) return;

    const at = Number.isFinite(atMs) ? Math.max(0, atMs) : 0;
    this.#currentAtMs = at;
    if (this.#decoder !== undefined) {
      this.#consume(chunk, at);
      return;
    }

    // Hold the first bytes until the encoding is known so that a legacy-encoded document is not
    // permanently decoded as replacement characters. Buffered chunks are replayed with their
    // original arrival times, so signal timing and observed byte positions stay unchanged.
    // Small chunks may outlive this call; callers can safely reuse their input buffers.
    // A chunk at least as large as the sniff window is always consumed before write returns.
    this.#pending.push({
      chunk: chunk.byteLength < CHARSET_SNIFF_LIMIT ? Uint8Array.from(chunk) : chunk,
      atMs: at,
    });
    this.#pendingBytes += chunk.byteLength;
    this.#resolveDecoder(false);
  }

  end(atMs = this.#currentAtMs): DocumentSignals {
    if (this.#result !== undefined) return this.#result;

    const at = Number.isFinite(atMs) ? Math.max(0, atMs) : this.#currentAtMs;
    this.#resolveDecoder(true);
    this.#currentAtMs = at;
    const tail = this.#decoder?.decode() ?? "";
    this.#parser.end(tail.length > 0 ? tail : undefined);
    this.#ended = true;

    const firstMainText = this.#mainTextStarted
      ? {
          value: normalizedText(this.#mainText, MAIN_TEXT_LIMIT),
          location: this.#mainTextLocation,
          ...this.#mainTextStarted,
        }
      : undefined;

    this.#result = {
      ...(this.#titles[0] === undefined ? {} : { title: this.#titles[0] }),
      titles: [...this.#titles],
      descriptions: [...this.#descriptions],
      canonicals: [...this.#canonicals],
      robots: [...this.#robots],
      socialMetadata: [...this.#socialMetadata],
      h1s: [...this.#h1s],
      ...(firstMainText === undefined || firstMainText.value.length === 0 ? {} : { firstMainText }),
      jsonLd: [...this.#jsonLd],
      ...(this.#headClosed === undefined ? {} : { headClosed: this.#headClosed }),
      ...(this.#bodyStarted === undefined ? {} : { bodyStarted: this.#bodyStarted }),
      ...(this.#documentClosed === undefined ? {} : { documentClosed: this.#documentClosed }),
    };
    return this.#result;
  }

  finish(atMs = this.#currentAtMs): DocumentSignals {
    return this.end(atMs);
  }

  #consume(chunk: Uint8Array, atMs: number): void {
    this.#bytesObserved += chunk.byteLength;
    this.#currentAtMs = atMs;
    const decoded = this.#decoder?.decode(chunk, { stream: true }) ?? "";
    if (decoded.length > 0) this.#parser.write(decoded);
  }

  #resolveDecoder(force: boolean): void {
    if (this.#decoder !== undefined) return;
    if (!force && this.#pendingBytes < 3) return;
    const charset = this.#pendingCharset();
    if (charset === undefined && !force && this.#pendingBytes < CHARSET_SNIFF_LIMIT) return;

    this.#decoder = new TextDecoder(charset ?? "utf-8");
    const pending = this.#pending;
    this.#pending = [];
    this.#pendingBytes = 0;
    for (const item of pending) this.#consume(item.chunk, item.atMs);
  }

  #pendingCharset(): string | undefined {
    if (this.#pending.length === 0) return undefined;
    const prefix = bufferedPrefix(this.#pending);
    return bomCharset(prefix) ?? this.#charset ?? declaredCharset(prefix);
  }

  #mark(): TimingMark {
    return timing(this.#currentAtMs, this.#bytesObserved);
  }

  #location(): ElementLocation {
    if (this.#inHead) return "head";
    if (this.#inBody) return "body";
    return "document";
  }

  #elementSignal(value: string, location = this.#location()): ElementSignal {
    return {
      value: normalizedText(value),
      location,
      ...this.#mark(),
    };
  }

  #onOpenTag(name: string, attributes: Readonly<Record<string, string>>): void {
    const alreadyExcluded = this.#templateDepth > 0 || this.#foreignContentDepth > 0;
    if (name === "template") this.#templateDepth += 1;
    if (name === "svg" || name === "math") this.#foreignContentDepth += 1;

    // A template's inert document fragment and SVG/MathML foreign content are not
    // document SEO signals, even when they contain HTML-looking element names.
    if (alreadyExcluded || name === "template" || name === "svg" || name === "math") {
      return;
    }

    const {
      name: metaNameAttribute,
      property: metaPropertyAttribute,
      content,
      rel,
      href,
      type: scriptType,
    } = attributes;
    if (name === "head") this.#inHead = true;
    if (name === "body") {
      if (this.#bodyStarted === undefined) this.#bodyStarted = this.#mark();
      this.#inBody = true;
    }

    const location = this.#location();

    if (
      name === "title" &&
      this.#titleCapture === undefined &&
      this.#titles.length < SIGNAL_LIMIT
    ) {
      this.#titleCapture = { location, value: "" };
    }

    if (name === "meta") {
      const metaName = metaNameAttribute?.trim().toLowerCase();
      const metaProperty = metaPropertyAttribute?.trim().toLowerCase();
      if (
        content !== undefined &&
        metaName === "description" &&
        this.#descriptions.length < SIGNAL_LIMIT
      ) {
        this.#descriptions.push(this.#elementSignal(content, location));
      }
      if (
        content !== undefined &&
        isRobotsAudience(metaName) &&
        this.#robots.length < SIGNAL_LIMIT
      ) {
        this.#robots.push({
          ...this.#elementSignal(content, location),
          audience: metaName,
        });
      }
      const socialProperty = isSocialMetadataProperty(metaProperty)
        ? metaProperty
        : isSocialMetadataProperty(metaName)
          ? metaName
          : undefined;
      if (content !== undefined && socialProperty !== undefined) {
        const count = this.#socialMetadataCounts.get(socialProperty) ?? 0;
        if (count < SIGNAL_LIMIT) {
          this.#socialMetadata.push({
            ...this.#elementSignal(content, location),
            property: socialProperty,
          });
          this.#socialMetadataCounts.set(socialProperty, count + 1);
        }
      }
    }

    if (name === "link") {
      const relations = rel?.toLowerCase().split(/\s+/u) ?? [];
      if (
        href !== undefined &&
        relations.includes("canonical") &&
        this.#canonicals.length < SIGNAL_LIMIT
      ) {
        this.#canonicals.push(this.#elementSignal(href, location));
      }
    }

    if (name === "h1" && this.#h1Capture === undefined && this.#h1s.length < SIGNAL_LIMIT) {
      this.#h1Capture = { location, value: "" };
    }

    if (name === "main") this.#mainDepth += 1;
    if (this.#mainDepth > 0 && ["script", "style", "template", "noscript"].includes(name)) {
      this.#ignoredMainTextDepth += 1;
    }

    const scriptMediaType = scriptType?.split(";", 1)[0]?.trim().toLowerCase();
    if (name === "script" && scriptMediaType === "application/ld+json") {
      this.#scriptCapture = {
        jsonLd: true,
        location,
        value: "",
        bytes: 0,
        truncated: false,
        omitted: this.#jsonLd.length >= JSON_LD_BLOCK_LIMIT,
      };
    }
  }

  #onText(value: string): void {
    if (this.#templateDepth > 0 || this.#foreignContentDepth > 0) return;

    if (this.#titleCapture !== undefined) {
      this.#titleCapture.value = `${this.#titleCapture.value}${value}`.slice(
        0,
        ELEMENT_VALUE_LIMIT,
      );
    }
    if (this.#h1Capture !== undefined) {
      this.#h1Capture.value = `${this.#h1Capture.value}${value}`.slice(0, ELEMENT_VALUE_LIMIT);
    }
    if (this.#scriptCapture !== undefined) {
      this.#scriptCapture.bytes += Buffer.byteLength(value, "utf8");
      if (!this.#scriptCapture.omitted) {
        const remaining = JSON_LD_CAPTURE_LIMIT - this.#scriptCapture.value.length;
        if (remaining > 0) this.#scriptCapture.value += value.slice(0, remaining);
        if (value.length > remaining) this.#scriptCapture.truncated = true;
      }
    }

    if (this.#mainDepth > 0 && this.#ignoredMainTextDepth === 0 && this.#mainText.length < 1_024) {
      if (this.#mainTextStarted === undefined && /\S/u.test(value)) {
        this.#mainTextStarted = this.#mark();
        this.#mainTextLocation = this.#location();
      }
      if (this.#mainTextStarted !== undefined) {
        this.#mainText += value.slice(0, 1_024 - this.#mainText.length);
      }
    }
  }

  #onCloseTag(name: string, isImplied: boolean): void {
    if (this.#templateDepth > 0 || this.#foreignContentDepth > 0) {
      if (name === "template") this.#templateDepth = Math.max(0, this.#templateDepth - 1);
      if (name === "svg" || name === "math") {
        this.#foreignContentDepth = Math.max(0, this.#foreignContentDepth - 1);
      }
      return;
    }

    if (name === "title" && this.#titleCapture !== undefined) {
      const value = normalizedText(this.#titleCapture.value);
      if (value.length > 0) {
        this.#titles.push({
          value,
          location: this.#titleCapture.location,
          ...this.#mark(),
        });
      }
      this.#titleCapture = undefined;
    }

    if (name === "h1" && this.#h1Capture !== undefined) {
      const value = normalizedText(this.#h1Capture.value);
      if (value.length > 0) {
        this.#h1s.push({
          value,
          location: this.#h1Capture.location,
          ...this.#mark(),
        });
      }
      this.#h1Capture = undefined;
    }

    if (name === "script" && this.#scriptCapture !== undefined) {
      if (this.#scriptCapture.jsonLd) this.#recordJsonLd(this.#scriptCapture);
      this.#scriptCapture = undefined;
    }

    if (this.#mainDepth > 0 && ["script", "style", "template", "noscript"].includes(name)) {
      this.#ignoredMainTextDepth = Math.max(0, this.#ignoredMainTextDepth - 1);
    }
    if (name === "main") this.#mainDepth = Math.max(0, this.#mainDepth - 1);

    if (name === "head") {
      if (this.#headClosed === undefined) this.#headClosed = this.#mark();
      this.#inHead = false;
    }
    if (name === "body") this.#inBody = false;
    if (name === "html" && !isImplied && this.#documentClosed === undefined) {
      this.#documentClosed = this.#mark();
    }
  }

  #recordJsonLd(capture: ScriptCapture): void {
    const mark = this.#mark();
    if (capture.omitted) {
      if (!this.#jsonLdLimitReported) {
        this.#jsonLdLimitReported = true;
        this.#jsonLd.push({
          location: capture.location,
          types: [],
          bytes: capture.bytes,
          analysisLimit: `Additional JSON-LD blocks exceeded the ${JSON_LD_BLOCK_LIMIT}-block analysis limit.`,
          ...mark,
        });
      }
      return;
    }
    if (capture.truncated) {
      this.#jsonLd.push({
        location: capture.location,
        types: [],
        bytes: capture.bytes,
        analysisLimit: `JSON-LD block exceeded the ${JSON_LD_CAPTURE_LIMIT}-character analysis limit.`,
        ...mark,
      });
      return;
    }
    try {
      const parsed: unknown = JSON.parse(capture.value);
      const types = new Set<string>();
      collectJsonLdTypes(parsed, types);
      this.#jsonLd.push({
        location: capture.location,
        valid: true,
        types: [...types].sort(),
        bytes: capture.bytes,
        ...mark,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid JSON";
      this.#jsonLd.push({
        location: capture.location,
        valid: false,
        types: [],
        bytes: capture.bytes,
        error: message.slice(0, 240),
        ...mark,
      });
    }
  }
}

export function createStreamInspector(options: StreamInspectorOptions = {}): StreamInspector {
  return new HtmlStreamInspector(options.charset);
}
