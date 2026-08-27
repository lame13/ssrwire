export type Severity = "info" | "warning" | "error";

export type ElementLocation = "head" | "body" | "document";

export interface TimingMark {
  readonly atMs: number;
  readonly observedByByte: number;
}

export interface ElementSignal extends TimingMark {
  readonly value: string;
  readonly location: ElementLocation;
}

export type RobotsAudience = "robots" | "googlebot" | "bingbot";

export interface RobotsSignal extends ElementSignal {
  readonly audience: RobotsAudience;
}

export type SocialMetadataProperty =
  | "og:title"
  | "og:type"
  | "og:url"
  | "og:image"
  | "og:description"
  | "twitter:card"
  | "twitter:title"
  | "twitter:description"
  | "twitter:image";

export interface SocialMetadataSignal extends ElementSignal {
  readonly property: SocialMetadataProperty;
}

export interface JsonLdSignal extends TimingMark {
  readonly location: ElementLocation;
  readonly valid?: boolean;
  readonly types: readonly string[];
  readonly bytes: number;
  readonly analysisLimit?: string;
  readonly error?: string;
}

export interface DocumentSignals {
  readonly title?: ElementSignal;
  readonly titles?: readonly ElementSignal[];
  readonly descriptions: readonly ElementSignal[];
  readonly canonicals: readonly ElementSignal[];
  readonly robots: readonly RobotsSignal[];
  /** Present on probes produced by SSRWire 0.3.0 and newer. */
  readonly socialMetadata?: readonly SocialMetadataSignal[];
  readonly h1s: readonly ElementSignal[];
  readonly firstMainText?: ElementSignal;
  readonly jsonLd: readonly JsonLdSignal[];
  readonly headClosed?: TimingMark;
  readonly bodyStarted?: TimingMark;
  readonly documentClosed?: TimingMark;
}

export interface AgentProfile {
  readonly key: string;
  readonly label: string;
  readonly userAgent: string;
  readonly requiresHeadMetadata: boolean;
}

export interface RedirectHop {
  readonly url: string;
  readonly status: number;
  readonly location: string;
  readonly durationMs: number;
}

export interface HeaderSnapshot {
  readonly values: Readonly<Record<string, string>>;
  readonly setCookiePresent: boolean;
}

export interface ProbeTimings {
  readonly headersMs: number;
  readonly firstByteMs?: number;
  readonly completeMs?: number;
}

export type ProbeCompletion =
  | "complete"
  | "max-bytes-exceeded"
  | "timeout"
  | "network-error"
  | "invalid-response";

export interface ProbeOptions {
  readonly url: string;
  readonly agent: AgentProfile;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxRedirects: number;
  /** Keep reflected header values internal so callers can analyze raw evidence before redaction. */
  readonly redactHeaderValues?: boolean;
}

export interface ProbeResult {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly agent: AgentProfile;
  readonly status?: number;
  readonly redirects: readonly RedirectHop[];
  readonly headers: HeaderSnapshot;
  readonly timings: ProbeTimings;
  readonly bytesRead: number;
  readonly bodySha256?: string;
  readonly signals: DocumentSignals;
  readonly completion: ProbeCompletion;
  readonly error?: string;
  /** One-based audit sample number. Low-level probeUrl() calls leave this unset. */
  readonly sample?: number;
}

export interface TargetExpectations {
  readonly statuses: readonly number[];
  readonly finalUrl?: string;
  readonly requireTitle: boolean;
  readonly requireDescription: boolean;
  readonly requireCanonical: boolean;
  readonly requireH1: boolean;
  readonly requireMainText: boolean;
  /** Require the four Open Graph protocol basic metadata properties. Defaults to false. */
  readonly requireOpenGraph?: boolean;
  /** Require SSRWire's Twitter Card readiness contract. Defaults to false. */
  readonly requireTwitterCard?: boolean;
  readonly maxFirstByteMs?: number;
  readonly maxCriticalMs?: number;
}

export interface AuditTarget {
  readonly url: string;
  readonly expectations: TargetExpectations;
}

export interface SsrWireConfig {
  readonly targets: readonly AuditTarget[];
  readonly agents: readonly AgentProfile[];
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxRedirects: number;
  /** Total samples per target and agent. Defaults to one for programmatic callers. */
  readonly repeat?: number;
}

export interface TimingStats {
  readonly samples: number;
  readonly minMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly spreadMs: number;
}

export interface StabilityTimings {
  readonly headers?: TimingStats;
  readonly firstByte?: TimingStats;
  readonly criticalSignals?: TimingStats;
  readonly complete?: TimingStats;
}

export interface StabilityVariants {
  readonly completion: number;
  readonly status: number;
  readonly finalUrl: number;
  readonly redirectChain: number;
  readonly bodySha256: number;
  readonly metadataValues: number;
  readonly metadataLocations: number;
}

export interface AgentStability {
  readonly agent: AgentProfile;
  readonly samples: number;
  readonly complete: number;
  readonly incomplete: number;
  readonly timings: StabilityTimings;
  readonly variants: StabilityVariants;
}

export interface Finding {
  readonly code: string;
  readonly severity: Severity;
  readonly message: string;
  readonly url: string;
  readonly agent?: string;
  readonly evidence?: Readonly<Record<string, string | number | boolean>>;
}

export interface TargetAuditResult {
  readonly target: AuditTarget;
  readonly probes: readonly ProbeResult[];
  readonly findings: readonly Finding[];
  readonly stability?: readonly AgentStability[];
}

export interface AuditSummary {
  readonly targets: number;
  readonly probes: number;
  readonly errors: number;
  readonly warnings: number;
  readonly info: number;
  readonly incomplete: number;
}

export interface AuditResult {
  readonly version: string;
  readonly generatedAt: string;
  readonly durationMs: number;
  readonly repeat?: number;
  readonly results: readonly TargetAuditResult[];
  readonly summary: AuditSummary;
}

export type ReportFormat = "terminal" | "json" | "sarif";
