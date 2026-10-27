// SDK example for the npm packages (docs/sdk-example.md). The first part needs only the installed
// packages: no deployed API, database or cloud credentials. The last part runs only when VAP_URL
// names a deployed API.
//
//   node offline-check.mjs <adapters.json>
import { canonicalize, PROTOCOL_VERSION, sha256Digest } from "@verified-action-protocol/protocol";
import { buildRegistry, loadAdaptersConfig } from "@verified-action-protocol/adapters";
import { staticConformance, tokenFromEnv, VapClient } from "@verified-action-protocol/sdk";

const file = process.argv[2];
if (!file) {
  console.error("usage: node offline-check.mjs <adapters.json>");
  process.exit(2);
}

// 1. Load a declarative adapter configuration and freeze it into a registry. Registration
//    validates every action descriptor against the protocol schemas.
const registry = buildRegistry(loadAdaptersConfig(file), { enableBrowser: false });
console.log(`protocol ${PROTOCOL_VERSION}; policy revision ${registry.policyRevision}`);
for (const a of registry.listActions()) console.log(`  action ${a.descriptor.id} (tier ${a.descriptor.risk_tier})`);

// 2. Static conformance of each adapter: schema validity, tier and capability coherence.
let errors = 0;
for (const adapter of registry.adapters()) {
  const findings = await staticConformance(adapter);
  for (const f of findings) console.log(`  ${f.severity}: ${adapter.id} ${f.action_id ?? ""} ${f.message}`);
  errors += findings.filter((f) => f.severity === "error").length;
  console.log(`conformance ${adapter.id}: ${findings.length} finding(s), ${findings.filter((f) => f.severity === "error").length} error(s)`);
}

// 3. Canonical JSON and digests: key order does not change the digest.
const a = sha256Digest({ issue_id: "42", status: "closed" });
const b = sha256Digest({ status: "closed", issue_id: "42" });
console.log(`canonical ${canonicalize({ status: "closed", issue_id: "42" })} -> ${a}`);
if (a !== b) errors++;

// 4. Client (needs a deployed API): VAP_URL plus a token source, as for the vap CLI.
if (process.env.VAP_URL) {
  const client = new VapClient({ baseUrl: process.env.VAP_URL, token: tokenFromEnv() });
  const info = await client.info();
  console.log(`API at ${process.env.VAP_URL}: protocol ${info.protocol_version}`);
} else {
  console.log("VAP_URL not set: skipped the client call");
}

process.exit(errors === 0 ? 0 : 1);
