import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson: unknown = require("../package.json");

function readVersion(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string"
  ) {
    return value.version;
  }

  throw new Error("SSRWire could not read its package version.");
}

export const VERSION = readVersion(packageJson);
