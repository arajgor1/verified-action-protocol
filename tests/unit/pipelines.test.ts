// Static checks of the cloud dispatcher against the pipelines it submits. Cloud Build rejects a
// substitution that a template never references, which once broke `vap-cloud.sh demo` before any
// step ran; these checks catch that class of mistake without submitting a build.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = readFileSync(path.join(ROOT, "scripts/vap-cloud.sh"), "utf8");

const submissions = [...cli.matchAll(/submit (infra\/gcp\/cloudbuild\.[a-z-]+\.yaml) "([^"]+)"/g)].map((m) => ({
  file: m[1],
  // The dispatcher always adds _EVIDENCE_BUCKET.
  keys: [...m[2].split(",").map((kv) => kv.split("=")[0]), "_EVIDENCE_BUCKET"],
}));

test("the dispatcher submits every pipeline it documents", () => {
  assert.ok(submissions.length >= 10, `found ${submissions.length} submissions`);
});

for (const s of submissions) {
  test(`${s.file}: every substitution passed is declared and referenced`, () => {
    const yaml = readFileSync(path.join(ROOT, s.file), "utf8");
    for (const k of s.keys) {
      assert.match(yaml, new RegExp(`^  ${k}:`, "m"), `${k} is not declared in ${s.file}`);
      assert.ok(yaml.includes(`\${${k}}`), `${k} is passed but never referenced in ${s.file} (Cloud Build rejects the build)`);
    }
  });

  test(`${s.file}: sets the cloud execution guard and fails fast in multi-command steps`, () => {
    const yaml = readFileSync(path.join(ROOT, s.file), "utf8");
    assert.match(yaml, /VAP_CLOUD_EXECUTION=1/);
    for (const m of yaml.matchAll(/^ {8}set -([a-z]+)( pipefail)?$/gm)) assert.ok(m[1].includes("e"), `${s.file}: "set -${m[1]}" without -e`);
  });
}
