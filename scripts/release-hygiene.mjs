#!/usr/bin/env node
// Public-disclosure gate. Scans a source tree, a release archive or the entire git history for
// secret classes and files outside the release allowlist. Reports only counts and categories,
// never matched values.
//
//   node scripts/release-hygiene.mjs --tree .
//   node scripts/release-hygiene.mjs --archive release-out/source-<sha>.tar.gz
//   node scripts/release-hygiene.mjs --history
//
// Optional operator-private rules: VAP_PRIVATE_SCAN_RULES may name a file OUTSIDE the
// repository with one prohibited literal per line. Its contents and path are never printed
// and must never be committed.
import "./cloud-guard.ts";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const PATTERNS = {
  private_key_block: /-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/,
  service_account_key: /"private_key_id"\s*:\s*"[0-9a-f]{20,}"/,
  aws_access_key: /\bAKIA[0-9A-Z]{16}\b/,
  github_token: /\b(gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,})\b/,
  google_api_key: /\bAIza[0-9A-Za-z_-]{35}\b/,
  google_oauth_token: /\bya29\.[A-Za-z0-9._-]{30,}/,
  slack_token: /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  llm_provider_key: /\bsk-(or-v1-|ant-|proj-)?[A-Za-z0-9_-]{32,}\b/,
  huggingface_token: /\bhf_[A-Za-z0-9]{30,}\b/,
  jwt: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  credential_assignment: /\b(password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["'][^"'\s$]{16,}["']/i,
};

const DENIED_NAMES = [/\.pem$/i, /\.p12$/i, /\.pfx$/i, /\.key$/i, /-key\.json$/i, /credentials?/i, /(^|\/)\.env(\..+)?$/, /(^|\/)id_(rsa|ed25519)/, /\.npmrc$/, /service[-_]account.*\.json$/i];
const ALLOWED_DENIED = [/(^|\/)\.env\.example$/];
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "release-out", "reports", "benchmark-results", ".ms-playwright"]);

function globToRegex(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp(`^${re}$`);
}

function loadAllowlist(root) {
  const file = path.join(root, "release-allowlist.txt");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map(globToRegex);
}

// Owner-specific identifiers (project id and number) arrive from the pipeline at run time through
// VAP_PRIVATE_LITERALS (comma-separated) and are never written to the repository.
function privateRules() {
  const p = process.env.VAP_PRIVATE_SCAN_RULES;
  const fromFile = p ? readFileSync(p, "utf8").split("\n") : [];
  const fromEnv = (process.env.VAP_PRIVATE_LITERALS ?? "").split(",");
  return [...fromFile, ...fromEnv].map((l) => l.trim()).filter((l) => l.length >= 6);
}

function walk(dir, root, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    // Generated directories are skipped only at the tree root; nested ones are scanned.
    if (SKIP_DIRS.has(e.name) && (dir === root || e.name === "node_modules" || e.name === ".git")) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (e.isDirectory()) walk(full, root, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

const findings = new Map();
const advisories = {};
const add = (category) => findings.set(category, (findings.get(category) ?? 0) + 1);

function scanText(text, rules) {
  for (const [cat, re] of Object.entries(PATTERNS)) if (re.test(text)) add(cat);
  for (const lit of rules) if (text.includes(lit)) add("operator_private_rule");
}

function scanNames(files, allow) {
  for (const f of files) {
    if (DENIED_NAMES.some((re) => re.test(f)) && !ALLOWED_DENIED.some((re) => re.test(f))) add("denied_filename");
    if (allow && !allow.some((re) => re.test(f))) add("outside_release_allowlist");
  }
}

const args = process.argv.slice(2);
const mode = args[0];
const rules = privateRules();
let scanned = 0;

if (mode === "--tree") {
  const root = path.resolve(args[1] ?? ".");
  const allow = loadAllowlist(root);
  const files = walk(root, root, []);
  scanNames(files, allow);
  for (const f of files) {
    const full = path.join(root, f);
    if (statSync(full).size > 5 * 1024 * 1024) {
      add("oversized_file_unscanned");
      continue;
    }
    scanText(readFileSync(full, "utf8"), rules);
    scanned++;
  }
} else if (mode === "--archive") {
  const archive = args[1];
  const list = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter((f) => f && !f.endsWith("/"));
  scanNames(list, loadAllowlist(process.cwd()));
  for (const f of list) {
    const content = execFileSync("tar", ["-xzOf", archive, "--", f], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    scanText(content, rules);
    scanned++;
  }
} else if (mode === "--content") {
  // A packaging output (npm tarball, schema bundle): content and names only; the source
  // allowlist does not apply to package-internal paths.
  const archive = args[1];
  const list = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter((f) => f && !f.endsWith("/"));
  scanNames(list, null);
  for (const f of list) {
    scanText(execFileSync("tar", ["-xzOf", archive, "--", f], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }), rules);
    scanned++;
  }
} else if (mode === "--history") {
  const log = execFileSync("git", ["log", "--all", "-p", "--no-color", "--full-history"], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  scanText(log, []);
  // Owner identifiers in history are counted per commit. With VAP_HISTORY_PRIVATE_ADVISORY=1 they
  // are reported as a publication blocker without failing the build: history needs an operator
  // decision (rewrite or squash) before publication.
  if (rules.length > 0) {
    const commits = execFileSync("git", ["rev-list", "--all"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);
    let hits = 0;
    for (const c of commits) {
      const patch = execFileSync("git", ["show", "--no-color", "--format=%B", c], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      if (rules.some((lit) => patch.includes(lit))) hits++;
    }
    if (hits > 0) {
      if (process.env.VAP_HISTORY_PRIVATE_ADVISORY === "1") advisories.private_identifier_commits = hits;
      else findings.set("private_identifier_commits", hits);
    }
  }
  const names = execFileSync("git", ["log", "--all", "--name-only", "--pretty=format:"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean);
  scanNames([...new Set(names)], null);
  scanned = names.length;
} else {
  process.stderr.write("usage: release-hygiene.mjs --tree <dir> | --archive <file.tar.gz> | --content <package.tgz> | --history\n");
  process.exit(2);
}

const summary = { mode, files_scanned: scanned, private_rules_loaded: rules.length > 0, findings: Object.fromEntries(findings), advisories };
process.stdout.write(JSON.stringify(summary) + "\n");
if (findings.size > 0) {
  process.stderr.write("release hygiene FAILED: fix the findings above before publication (values are intentionally not printed)\n");
  process.exit(1);
}
