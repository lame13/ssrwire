import type { DocumentSignals, SocialMetadataProperty, SocialMetadataSignal } from "./types.js";

export const SOCIAL_METADATA_PROPERTIES = [
  "og:title",
  "og:type",
  "og:url",
  "og:image",
  "og:description",
  "twitter:card",
  "twitter:title",
  "twitter:description",
  "twitter:image",
] as const satisfies readonly SocialMetadataProperty[];

export const OPEN_GRAPH_PROPERTIES = [
  "og:title",
  "og:type",
  "og:url",
  "og:image",
  "og:description",
] as const satisfies readonly SocialMetadataProperty[];

export const OPEN_GRAPH_REQUIRED_PROPERTIES = [
  "og:title",
  "og:type",
  "og:url",
  "og:image",
] as const satisfies readonly SocialMetadataProperty[];

export const TWITTER_PROPERTIES = [
  "twitter:card",
  "twitter:title",
  "twitter:description",
  "twitter:image",
] as const satisfies readonly SocialMetadataProperty[];

export const TWITTER_CARD_REQUIRED_FIELDS = ["card", "title", "description", "image"] as const;
export type TwitterCardField = (typeof TWITTER_CARD_REQUIRED_FIELDS)[number];

const SOCIAL_METADATA_PROPERTY_SET = new Set<string>(SOCIAL_METADATA_PROPERTIES);
const SOCIAL_URL_PROPERTY_SET = new Set<SocialMetadataProperty>([
  "og:url",
  "og:image",
  "twitter:image",
]);

export function isSocialMetadataProperty(
  value: string | undefined,
): value is SocialMetadataProperty {
  return value !== undefined && SOCIAL_METADATA_PROPERTY_SET.has(value);
}

export function socialSignals(
  signals: DocumentSignals,
  property: SocialMetadataProperty,
): readonly SocialMetadataSignal[] {
  return (signals.socialMetadata ?? []).filter((signal) => signal.property === property);
}

export function firstSocialSignal(
  signals: DocumentSignals,
  property: SocialMetadataProperty,
): SocialMetadataSignal | undefined {
  return socialSignals(signals, property).find((signal) => signal.value.trim().length > 0);
}

export function effectiveTwitterCardSignal(
  signals: DocumentSignals,
  field: TwitterCardField,
): SocialMetadataSignal | undefined {
  if (field === "card") return firstSocialSignal(signals, "twitter:card");
  if (field === "title") {
    return firstSocialSignal(signals, "twitter:title") ?? firstSocialSignal(signals, "og:title");
  }
  if (field === "description") {
    return (
      firstSocialSignal(signals, "twitter:description") ??
      firstSocialSignal(signals, "og:description")
    );
  }
  return firstSocialSignal(signals, "twitter:image") ?? firstSocialSignal(signals, "og:image");
}

export function normalizeSocialValue(
  property: SocialMetadataProperty,
  value: string,
  baseUrl: string,
): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) return "";
  if (SOCIAL_URL_PROPERTY_SET.has(property)) {
    try {
      const url = new URL(normalized, baseUrl);
      url.hash = "";
      return url.href;
    } catch {
      return normalized;
    }
  }
  return property === "og:type" || property === "twitter:card"
    ? normalized.toLowerCase()
    : normalized;
}

export function isAbsoluteHttpSocialUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}
