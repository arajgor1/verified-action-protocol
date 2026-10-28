// Regression test for infra/gcp/gate-identities.sh targeting. In the 0.1.0-rc.1 managed gate run,
// commands without --project acted on the operator's active gcloud project instead of
// VAP_GCP_PROJECT. Here the script runs against a fake `gcloud` that records every call and
// resolves its project the way gcloud does (--project, else the positional project of
// `gcloud projects ...`, else the active project), with a deliberately different active project.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "infra/gcp/gate-identities.sh");
const TARGET = "vap-target-proj";
const ACTIVE = "vap-active-other";
const NUMBER = "123456789012";

// Read-only lookups answer for the project the call names (or the active one when it names
// none), as gcloud would; every other call succeeds without output.
const FAKE_GCLOUD = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GCLOUD_LOG"
proj="$CLOUDSDK_CORE_PROJECT"
for a in "$@"; do case "$a" in --project=*) proj="\${a#--project=}" ;; esac; done
case "$1 $2 $3" in
  "projects describe "*)
    [ -z "\${FAKE_MISSING:-}" ] || { echo "NOT_FOUND: project $3" >&2; exit 1; }
    printf '%s\\t%s\\t%s\\n' "\${FAKE_PROJECT_ID:-$3}" "${NUMBER}" "\${FAKE_STATE:-ACTIVE}" ;;
  "storage buckets list") printf '%s\\n' "\${FAKE_BUCKETS-\${proj}_cloudbuild}" ;;
  "artifacts repositories describe")
    [ -z "\${FAKE_NO_REPO:-}" ] || { echo "NOT_FOUND: repository" >&2; exit 1; }
    echo "Encryption: Google-managed key" >&2
    printf 'projects/%s/locations/us-central1/repositories/vap\\n' "$proj" ;;
  "iam service-accounts describe") exit 1 ;;
esac
exit 0
`;

const MUTATING = /^(iam service-accounts (create|delete|add-iam-policy-binding)|projects (add|remove)-iam-policy-binding|storage buckets (add|remove)-iam-policy-binding|artifacts repositories (add|remove)-iam-policy-binding)$/;

function run(op: string, extra: Record<string, string | undefined> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-ids-"));
  const bin = path.join(dir, "bin");
  const config = path.join(dir, "gcloud-config");
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(config, "configurations"), { recursive: true });
  // The active configuration names a different project as well.
  writeFileSync(path.join(config, "active_config"), "default");
  writeFileSync(path.join(config, "configurations", "config_default"), `[core]
project = ${ACTIVE}
`);
  writeFileSync(path.join(bin, "gcloud"), FAKE_GCLOUD);
  chmodSync(path.join(bin, "gcloud"), 0o755);
  const log = path.join(dir, "gcloud.log");
  writeFileSync(log, "");
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: dir,
    FAKE_GCLOUD_LOG: log,
    // A different active project, both as the environment override and in a config directory.
    CLOUDSDK_CORE_PROJECT: ACTIVE,
    CLOUDSDK_CONFIG: config,
    VAP_GCP_PROJECT: TARGET,
    VAP_SUBMITTER: "user:operator@example.com",
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const r = spawnSync("bash", [SCRIPT, op], { env, encoding: "utf8" });
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { status: r.status, stderr: r.stderr, stdout: r.stdout, calls };
}

// `gcloud projects <verb> <project>` has a two-word command; the others have three.
const verb = (call: string) => {
  const t = call.split(" ");
  return t.slice(0, t[0] === "projects" ? 2 : 3).join(" ");
};
const mutations = (calls: string[]) => calls.filter((c) => MUTATING.test(verb(c)));
function effectiveProject(call: string): string {
  const flag = call.match(/(?:^| )--project=(\S+)/);
  if (flag) return flag[1]!;
  const t = call.split(" ");
  if (t[0] === "projects") return t[2]!;
  return ACTIVE;
}
function assertOnlyTarget(calls: string[]) {
  assert.ok(calls.length > 0, "no gcloud calls recorded");
  for (const c of calls) {
    assert.equal(effectiveProject(c), TARGET, `call does not target ${TARGET}: gcloud ${c}`);
    assert.ok(!c.includes(ACTIVE), `call mentions the active project: gcloud ${c}`);
    for (const email of c.match(/[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com/g) ?? []) assert.ok(email.endsWith(`@${TARGET}.iam.gserviceaccount.com`), `foreign account ${email}`);
    for (const url of c.match(/gs:\/\/\S+/g) ?? []) assert.equal(url, `gs://${TARGET}_cloudbuild`, `foreign bucket ${url}`);
  }
}

test("create targets only the explicitly supplied project, never the active one", () => {
  const r = run("create");
  assert.equal(r.status, 0, r.stderr);
  assertOnlyTarget(r.calls);
  const m = mutations(r.calls).map(verb);
  assert.equal(m.filter((v) => v === "iam service-accounts create").length, 2);
  assert.equal(m.filter((v) => v === "artifacts repositories add-iam-policy-binding").length, 1);
  assert.equal(m.filter((v) => v === "storage buckets add-iam-policy-binding").length, 4);
  assert.ok(m.filter((v) => v === "projects add-iam-policy-binding").length >= 15);
  // Every check happens before the first change.
  const first = r.calls.findIndex((c) => MUTATING.test(verb(c)));
  assert.ok(r.calls.slice(0, first).some((c) => c.startsWith(`projects describe ${TARGET} `)));
  assert.ok(r.calls.slice(0, first).some((c) => c.startsWith("storage buckets list ")));
  assert.ok(r.calls.slice(0, first).some((c) => c.startsWith("artifacts repositories describe ")));
});

test("remove targets only the explicitly supplied project, including deletion and resource bindings", () => {
  const r = run("remove");
  assert.equal(r.status, 0, r.stderr);
  assertOnlyTarget(r.calls);
  const m = mutations(r.calls).map(verb);
  assert.equal(m.filter((v) => v === "iam service-accounts delete").length, 2);
  assert.equal(m.filter((v) => v === "artifacts repositories remove-iam-policy-binding").length, 1);
  assert.equal(m.filter((v) => v === "storage buckets remove-iam-policy-binding").length, 4);
  assert.ok(m.filter((v) => v === "projects remove-iam-policy-binding").length >= 15);
});

test("remove skips bindings on a bucket or repository that is not in the target project", () => {
  const r = run("remove", { FAKE_BUCKETS: "someone-else_cloudbuild", FAKE_NO_REPO: "1" });
  assert.equal(r.status, 0, r.stderr);
  assertOnlyTarget(r.calls);
  const m = mutations(r.calls).map(verb);
  assert.ok(!m.some((v) => v.startsWith("storage buckets") || v.startsWith("artifacts repositories")), m.join("\n"));
});

const refusals: [string, string, Record<string, string | undefined>][] = [
  ["no target project", "create", { VAP_GCP_PROJECT: undefined }],
  ["no target project (remove)", "remove", { VAP_GCP_PROJECT: undefined }],
  ["a malformed project id", "create", { VAP_GCP_PROJECT: "Not A Project" }],
  ["no submitter", "create", { VAP_SUBMITTER: undefined }],
  ["an unknown operation", "apply", {}],
  ["a missing project", "create", { FAKE_MISSING: "1" }],
  ["a missing project (remove)", "remove", { FAKE_MISSING: "1" }],
  ["a lookup that returns another project", "create", { FAKE_PROJECT_ID: "someone-else" }],
  ["a project number that does not match", "create", { VAP_GCP_PROJECT_NUMBER: "999999999999" }],
  ["a project number that does not match (remove)", "remove", { VAP_GCP_PROJECT_NUMBER: "999999999999" }],
  ["a project that is not ACTIVE", "create", { FAKE_STATE: "DELETE_REQUESTED" }],
  ["a project that is not ACTIVE (remove)", "remove", { FAKE_STATE: "DELETE_REQUESTED" }],
  ["a build bucket outside the project", "create", { FAKE_BUCKETS: "someone-else_cloudbuild" }],
  ["no vap repository in the project", "create", { FAKE_NO_REPO: "1" }],
];
for (const [what, op, extra] of refusals) {
  test(`${op} with ${what} stops before any change`, () => {
    const r = run(op, extra);
    assert.notEqual(r.status, 0, `exit 0 with ${what}`);
    assert.deepEqual(mutations(r.calls), [], `changes were attempted:\n${mutations(r.calls).join("\n")}`);
    for (const c of r.calls) assert.notEqual(effectiveProject(c), ACTIVE, `read used the active project: gcloud ${c}`);
  });
}

test("a matching project number is accepted", () => {
  const r = run("create", { VAP_GCP_PROJECT_NUMBER: NUMBER });
  assert.equal(r.status, 0, r.stderr);
  assertOnlyTarget(r.calls);
});

test("the script never reads or changes gcloud configuration", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(src, /gcloud config /);
  assert.doesNotMatch(src, /CLOUDSDK_CORE_PROJECT/);
});
