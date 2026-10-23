// Cleanup for Layer B test issues. Lists issues in the dedicated demo repository that carry a
// VAP workflow marker. Closing them requires both --close and VAP_GITHUB_CLEANUP_AUTHORIZED=1
// (the owner's authorization of the cleanup scope); a GitHub App cannot delete issues, so
// "cleanup" means closing with state_reason "not_planned" and a comment-free PATCH.
//
//   VAP_GITHUB_REPOSITORY=owner/repo VAP_GITHUB_APP_ID=... VAP_GITHUB_APP_INSTALLATION_ID=... \
//   VAP_GITHUB_APP_PRIVATE_KEY=... node demo/ci-failure/cleanup-github.ts [--close] [--only <issue numbers, comma-separated>]
import "../../scripts/cloud-guard.ts";
import { appJwt } from "@vap/adapters";

const repo = process.env.VAP_GITHUB_REPOSITORY ?? "";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("VAP_GITHUB_REPOSITORY must be owner/repo");
const close = process.argv.includes("--close");
const onlyArg = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const only = onlyArg ? new Set(onlyArg.split(",").map(Number)) : null;
if (close && process.env.VAP_GITHUB_CLEANUP_AUTHORIZED !== "1") throw new Error("closing issues requires VAP_GITHUB_CLEANUP_AUTHORIZED=1 (owner-authorized cleanup scope)");
if (close && !only) throw new Error("--close requires --only <issue numbers> taken from github-resources.json; it never closes every marker issue");
if (!/^\d{1,20}$/.test(process.env.VAP_GITHUB_APP_INSTALLATION_ID ?? "")) throw new Error("VAP_GITHUB_APP_INSTALLATION_ID must be numeric");

const H = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "vap-demo-cleanup/0.1" };

async function token(): Promise<string> {
  const jwt = appJwt(process.env.VAP_GITHUB_APP_ID ?? "", process.env.VAP_GITHUB_APP_PRIVATE_KEY ?? "");
  const r = await fetch(`https://api.github.com/app/installations/${process.env.VAP_GITHUB_APP_INSTALLATION_ID}/access_tokens`, { method: "POST", headers: { ...H, authorization: `Bearer ${jwt}` } });
  if (r.status !== 201) throw new Error(`token exchange failed (HTTP ${r.status})`);
  return ((await r.json()) as { token: string }).token;
}

const t = await token();
const auth = { ...H, authorization: `Bearer ${t}` };
const found: { number: number; state: string; marker: string }[] = [];
for (let page = 1; page <= 10; page++) {
  const r = await fetch(`https://api.github.com/repos/${repo}/issues?state=all&per_page=100&page=${page}`, { headers: auth });
  if (r.status !== 200) throw new Error(`listing failed (HTTP ${r.status})`);
  const list = (await r.json()) as { number: number; state: string; body: string | null; pull_request?: unknown }[];
  for (const i of list) {
    const m = /<!-- vap-workflow-id: (vapwf-[0-9a-f]{24}) -->/.exec(i.body ?? "");
    if (m && !i.pull_request && (!only || only.has(i.number))) found.push({ number: i.number, state: i.state, marker: m[1] });
  }
  if (list.length < 100) break;
}
process.stdout.write(`${found.length} issue(s) with a VAP workflow marker in ${repo}\n`);
for (const f of found) process.stdout.write(`  #${f.number} ${f.state} ${f.marker}\n`);
if (close) {
  for (const f of found.filter((x) => x.state === "open")) {
    const r = await fetch(`https://api.github.com/repos/${repo}/issues/${f.number}`, { method: "PATCH", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ state: "closed", state_reason: "not_planned" }) });
    process.stdout.write(`  closed #${f.number}: HTTP ${r.status}\n`);
  }
}
