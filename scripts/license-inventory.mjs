#!/usr/bin/env node
// Production dependency license inventory from installed package manifests. Flags licenses
// that need review against Apache-2.0 distribution. Not legal clearance.
import "./cloud-guard.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const REVIEW = /(GPL|AGPL|LGPL|SSPL|BUSL|CC-BY-NC|Commons-Clause|UNLICENSED)/i;
const seen = new Map();

function visit(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (name.startsWith("@")) {
      visit(full);
      continue;
    }
    const pj = path.join(full, "package.json");
    if (!existsSync(pj)) continue;
    const m = JSON.parse(readFileSync(pj, "utf8"));
    const license = typeof m.license === "string" ? m.license : Array.isArray(m.licenses) ? m.licenses.map((l) => l.type).join(" OR ") : "UNKNOWN";
    seen.set(`${m.name}@${m.version}`, { name: m.name, version: m.version, license, needs_review: REVIEW.test(license) || license === "UNKNOWN" });
    visit(path.join(full, "node_modules"));
  }
}

visit("node_modules");
const list = [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
process.stdout.write(JSON.stringify({ generated_at: new Date().toISOString(), packages: list.length, needs_review: list.filter((p) => p.needs_review), inventory: list }, null, 2) + "\n");
