#!/usr/bin/env node
// Writes a Google-signed ID token (with the email claim) and the token's identity email.
//
//   node scripts/metadata-identity.mjs <audience> <token file> <subject file> [<target service account email>]
//
// With a target, the caller (the build identity) mints a token FOR that service account through
// the IAM Credentials API. That needs only iam.serviceAccounts.getOpenIdToken on the target
// (roles/iam.serviceAccountOpenIdTokenCreator granted on that one account), not Token Creator.
// Without a target, it asks the metadata server for the caller's own token (works on Compute
// and Cloud Run; Cloud Build has no identity endpoint). The token is never printed.
import "./cloud-guard.ts";
import { writeFileSync } from "node:fs";

const [audience, tokenFile, subjectFile, target] = process.argv.slice(2);
if (!audience || !tokenFile || !subjectFile) {
  process.stderr.write("usage: metadata-identity.mjs <audience> <token file> <subject file>\n");
  process.exit(2);
}
const base = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/";
const get = async (p) => {
  const r = await fetch(base + p, { headers: { "Metadata-Flavor": "Google" } });
  if (!r.ok) throw new Error(`metadata ${p.split("?")[0]} returned HTTP ${r.status}`);
  return (await r.text()).trim();
};
const mintFor = async (sa) => {
  const access = JSON.parse(await get("token")).access_token;
  const r = await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(sa)}:generateIdToken`, {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
    body: JSON.stringify({ audience, includeEmail: true }),
  });
  if (!r.ok) throw new Error(`IAM Credentials generateIdToken for ${sa} returned HTTP ${r.status}: the caller needs iam.serviceAccounts.getOpenIdToken on it`);
  return (await r.json()).token;
};
const email = target ?? (await get("email"));
// Cloud Build's metadata server has no identity endpoint (Compute and Cloud Run have one); there
// the caller can only mint for itself through IAM Credentials, which needs getOpenIdToken on itself.
let token;
if (target) token = await mintFor(target);
else {
  try {
    token = await get(`identity?audience=${encodeURIComponent(audience)}&format=full`);
  } catch {
    token = await mintFor(email);
  }
}
if (!/^ey[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) throw new Error("metadata server did not return a JWT");
const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
if (claims.email !== email || claims.email_verified !== true || claims.aud !== audience) throw new Error("ID token lacks the expected audience or verified email claim");
writeFileSync(tokenFile, token, { mode: 0o600 });
writeFileSync(subjectFile, email + "\n");
process.stdout.write(`identity token obtained (audience ${audience}, expires ${new Date(claims.exp * 1000).toISOString()})\n`);
