#!/usr/bin/env node
// Release manifest check (infra/gcp/cloudbuild.manifest.yaml). From a clone of the history
// bundle it compares the tested runtime commit with the final tree and fails unless:
//   - every path changed after the tested commit is documentation (docs/**, *.md);
//   - every `scripts/vap-cloud.sh <command>` and every infra/gcp/cloudbuild.*.yaml named in the
//     final documentation exists in the tested commit.
// It writes release-manifest.json with the diff, the image digests passed in and the result.
//
//   node scripts/release-manifest.mjs --repo <git dir> --tested <sha> --final <sha> --images <ref,ref> --out <dir>
import "./cloud-guard.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : null);
const repo = opt("repo") ?? ".";
const tested = opt("tested");
const final = opt("final") ?? "HEAD";
const images = (opt("images") ?? "").split(/[,+]/).filter(Boolean);
const out = opt("out") ?? "reports";
if (!tested || !/^[0-9a-f]{7,40}$/.test(tested)) {
  process.stderr.write("--tested <commit sha> is required\n");
  process.exit(2);
}
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

const testedFull = git("rev-parse", `${tested}^{commit}`).trim();
const finalFull = git("rev-parse", `${final}^{commit}`).trim();
const ancestor = (() => {
  try {
    git("merge-base", "--is-ancestor", testedFull, finalFull);
    return true;
  } catch {
    return false;
  }
})();
const diff = git("diff", "--name-status", testedFull, finalFull)
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    const [status, ...paths] = l.split("\t");
    return { status, path: paths[paths.length - 1], from: paths.length > 1 ? paths[0] : null };
  });
const isDoc = (p) => p !== null && (/^docs\//.test(p) || /(^|\/)[^/]+\.md$/.test(p));
const nonDoc = diff.filter((d) => !isDoc(d.path) || (d.from !== null && !isDoc(d.from)));
const commits = git("log", "--format=%H %s", `${testedFull}..${finalFull}`).split("\n").filter(Boolean);

// Documented commands and pipelines must exist in the tested commit.
const docFiles = git("ls-tree", "-r", "--name-only", finalFull).split("\n").filter((f) => /\.md$/.test(f));
const testedCli = git("show", `${testedFull}:scripts/vap-cloud.sh`);
const testedCommands = new Set([...testedCli.matchAll(/^ {2}([a-z-]+)\)/gm)].map((m) => m[1]));
const testedFiles = new Set(git("ls-tree", "-r", "--name-only", testedFull).split("\n"));
const commandProblems = [];
const commandsSeen = new Set();
for (const f of docFiles) {
  const text = git("show", `${finalFull}:${f}`);
  for (const m of text.matchAll(/scripts\/vap-cloud\.sh ([a-z-]+)/g)) {
    commandsSeen.add(m[1]);
    if (!testedCommands.has(m[1])) commandProblems.push(`${f}: vap-cloud.sh ${m[1]} is not a command in the tested commit`);
  }
  for (const m of text.matchAll(/infra\/gcp\/(cloudbuild\.[a-z-]+\.yaml)/g)) {
    if (!testedFiles.has(`infra/gcp/${m[1]}`)) commandProblems.push(`${f}: infra/gcp/${m[1]} does not exist in the tested commit`);
  }
}

const result = ancestor && nonDoc.length === 0 && commandProblems.length === 0 ? "pass" : "fail";
const manifest = {
  schema: "vap-release-manifest/0.1",
  tested_commit: testedFull,
  final_commit: finalFull,
  tested_is_ancestor_of_final: ancestor,
  commits_after_tested: commits,
  diff_after_tested: diff,
  non_documentation_changes: nonDoc,
  documented_commands: [...commandsSeen].sort(),
  documented_command_problems: commandProblems,
  images,
  result,
  generated_at: new Date().toISOString(),
};
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "release-manifest.json"), JSON.stringify(manifest, null, 2));
process.stdout.write(JSON.stringify({ result, commits_after_tested: commits.length, files_changed: diff.length, non_documentation_changes: nonDoc.length, documented_command_problems: commandProblems }) + "\n");
if (result !== "pass") process.exit(1);
