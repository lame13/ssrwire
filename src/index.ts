export { BUILTIN_AGENTS, resolveAgent, resolveAgents } from "./agents.js";
export { analyzeTarget, summarizeAudit } from "./analyze.js";
export { DEFAULT_CONCURRENCY, runAudit } from "./audit.js";
export {
  AUDIT_SCHEMA_VERSION,
  AuditReportError,
  parseAuditReport,
  parseAuditReportText,
  SUPPORTED_AUDIT_SCHEMA_VERSIONS,
} from "./audit-report.js";
export { renderGithub, renderJunit, renderMarkdown } from "./ci-reporters.js";
export { ComparisonError, compareAudits } from "./compare.js";
export {
  renderComparisonHtml,
  renderComparisonJson,
  renderComparisonReport,
  renderComparisonTerminal,
} from "./comparison-reporters.js";
export { loadConfig, parseHeaderOption } from "./config.js";
export { expectNoRegressions, RegressionError } from "./expect.js";
export {
  type AuditVerdict,
  auditVerdict,
  detectedFrameworkLabel,
  type ExplanationContext,
  explainFinding,
  type FindingExplanation,
  type FindingSnippet,
  type NextStep,
  nextSteps,
  targetVerdict,
  type VerdictKind,
} from "./explain.js";
export {
  detectFrameworkFromProbes,
  detectProjectFramework,
  FRAMEWORK_KEYS,
  type FrameworkDetection,
  type FrameworkKey,
  frameworkLabel,
  isFrameworkKey,
} from "./framework.js";
export {
  type AuditPolicyOutcome,
  type AuditReportOptions,
  renderAuditHtml,
} from "./html-report.js";
export { probeUrl } from "./http-probe.js";
export { redactProbe } from "./redact.js";
export { renderJson, renderReport, renderSarif, renderTerminal } from "./reporters.js";
export {
  assignTargetIds,
  discoverSitemapTargets,
  globToRegExp,
  type SitemapDiscovery,
  SitemapError,
  type SitemapOptions,
  targetIdFromUrl,
} from "./sitemap.js";
export {
  createStreamInspector,
  type StreamInspector,
  type StreamInspectorOptions,
} from "./stream-parser.js";
export type {
  AgentProfile,
  AgentStability,
  AuditComparison,
  AuditReportDescriptor,
  AuditResult,
  AuditSchemaVersion,
  AuditSummary,
  AuditTarget,
  CompareAuditOptions,
  ComparisonChange,
  ComparisonKind,
  ComparisonReportFormat,
  ComparisonScope,
  ComparisonSummary,
  ComparisonThresholds,
  ComparisonTimelineEvent,
  ComparisonTimelineLane,
  ComparisonTimelineSnapshot,
  DocumentSignals,
  ElementLocation,
  ElementSignal,
  Finding,
  HeaderSnapshot,
  JsonLdSignal,
  ProbeCompletion,
  ProbeOptions,
  ProbeResult,
  ProbeTimings,
  RedirectHop,
  ReportFormat,
  RobotsAudience,
  RobotsSignal,
  RobotsTxtEvidence,
  Severity,
  SocialMetadataProperty,
  SocialMetadataSignal,
  SsrWireConfig,
  StabilityTimings,
  StabilityVariants,
  StreamShape,
  TargetAuditResult,
  TargetComparison,
  TargetComparisonStatus,
  TargetExpectations,
  TimingMark,
  TimingStats,
  WaiverRecord,
} from "./types.js";
export { VERSION } from "./version.js";
export {
  applyWaivers,
  EXPIRED_WAIVER_CODE,
  isWaiverExpired,
  UNUSED_WAIVER_CODE,
  type WaiverOutcome,
} from "./waivers.js";
