#!/usr/bin/env node
// Writes publication-ready copies of generated release artifacts (SBOMs, scan reports, license
// inventory): owner identifiers passed at run time are replaced by placeholders, and the copies
// are verified to contain none. The originals stay in the private evidence location.
//
//   VAP_PRIVATE_LITERALS=<project>,<number> VAP_REGISTRY_PREFIX=<region>-docker.pkg.dev/<project>/ \
//   node scripts/sanitize-artifacts.mjs <source dir> <public dir> <file> [<file> ...]
import "./cloud-guard.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [src, dst, ...files] = process.argv.slice(2);
const literals = (process.env.VAP_PRIVATE_LITERALS ?? "").split(",").map((s) => s.trim()).filter((s) => s.length >= 6);
const prefix = process.env.VAP_REGISTRY_PREFIX ?? "";
if (!src || !dst || files.length === 0 || literals.length === 0) {
  process.stderr.write("usage: sanitize-artifacts.mjs <src> <dst> <file...> (VAP_PRIVATE_LITERALS required)\n");
  process.exit(2);
}
mkdirSync(dst, { recursive: true });
const leftovers = [];
for (const f of files) {
  let text = readFileSync(path.join(src, f), "utf8");
  if (prefix) text = text.split(prefix).join("<registry>/");
  literals.forEach((lit, i) => (text = text.split(lit).join(i === 0 ? "<project>" : `<private-${i}>`)));
  if (literals.some((lit) => text.includes(lit))) leftovers.push(f);
  writeFileSync(path.join(dst, f), text);
}
process.stdout.write(JSON.stringify({ sanitized: files.length, leftovers }) + "\n");
if (leftovers.length > 0) process.exit(1);
