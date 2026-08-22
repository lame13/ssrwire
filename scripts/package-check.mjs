import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const node = process.execPath;
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  throw new Error("npm_execpath is unavailable. Run this check with npm run package:check.");
}
const temporary = await mkdtemp(join(tmpdir(), "ssrwire-package-"));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });

  if (result.status !== 0 || result.error !== undefined) {
    const detail = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed\n${detail}`);
  }

  return result.stdout.trim();
}

function runNpm(args, cwd) {
  return run(node, [npmCli, ...args], cwd);
}

try {
  const packOutput = runNpm(
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
    process.cwd(),
  );
  const packed = JSON.parse(packOutput);
  const item = packed[0];
  if (
    !item ||
    typeof item.filename !== "string" ||
    typeof item.version !== "string" ||
    !Array.isArray(item.files)
  ) {
    throw new Error("npm pack returned an unexpected result.");
  }

  const required = [
    "dist/bin.js",
    "dist/cli.js",
    "dist/index.js",
    "dist/index.d.ts",
    "src/index.ts",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "PUBLISHING.md",
  ];
  const names = new Set(item.files.map((file) => file.path));
  const missing = required.filter((file) => !names.has(file));
  if (missing.length > 0) {
    throw new Error(`Package is missing required files: ${missing.join(", ")}`);
  }

  const installDirectory = join(temporary, "install");
  await mkdir(installDirectory);
  await writeFile(join(installDirectory, "package.json"), '{"private":true,"type":"module"}\n');

  const tarball = join(temporary, item.filename);
  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], installDirectory);
  const versionOutput = runNpm(["exec", "--", "ssrwire", "--version"], installDirectory);
  if (versionOutput !== item.version) throw new Error("Installed CLI returned the wrong version.");
  const helpOutput = runNpm(["exec", "--", "ssrwire", "--help"], installDirectory);
  if (!helpOutput.includes("Inspect streamed SSR HTML")) {
    throw new Error("Installed CLI did not render its help output.");
  }
  runNpm(["exec", "--", "ssrwire", "init", "smoke.config.yml"], installDirectory);
  const initialized = await readFile(join(installDirectory, "smoke.config.yml"), "utf8");
  if (!initialized.includes("targets:") || !initialized.includes("agents:")) {
    throw new Error("Installed CLI did not create a valid starter configuration.");
  }
  run(
    node,
    [join(installDirectory, "node_modules", "ssrwire", "dist", "bin.js"), "--version"],
    installDirectory,
  );

  const importScript = [
    'import { VERSION, runAudit } from "ssrwire";',
    'if (!VERSION || typeof runAudit !== "function") process.exit(1);',
  ].join("\n");
  const importPath = join(installDirectory, "import-smoke.mjs");
  await writeFile(importPath, `${importScript}\n`);
  run(node, [importPath], installDirectory);

  const packageJson = JSON.parse(
    await readFile(join(installDirectory, "node_modules", "ssrwire", "package.json"), "utf8"),
  );
  if (packageJson.name !== "ssrwire") {
    throw new Error("Installed package identity is incorrect.");
  }

  process.stdout.write(`Package smoke passed: ${item.filename}\n`);
} finally {
  await rm(temporary, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 10 : 0,
    retryDelay: 100,
  });
}
