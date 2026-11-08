#!/usr/bin/env node
// Rehearsal-local OpenID issuer for the ephemeral staging rehearsal. Google-signed ID tokens for
// the build identity need roles/iam.serviceAccountTokenCreator, which this project has not
// granted; this issuer exercises the same OIDC verification in the API (RS256 signature from a
// JWKS URL, issuer, audience, expiry, verified email) with a key generated inside the build.
//
//   node scripts/rehearsal-issuer.mjs keys <private dir> <public dir>
//   node scripts/rehearsal-issuer.mjs mint <private dir> <issuer> <audience> <email> <out file> [--expired]
import "./cloud-guard.ts";
import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [cmd, ...rest] = process.argv.slice(2);
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

if (cmd === "keys") {
  const [privDir, pubDir] = rest;
  mkdirSync(privDir, { recursive: true, mode: 0o700 });
  mkdirSync(pubDir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomBytes(8).toString("hex");
  writeFileSync(path.join(privDir, "key.pem"), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(path.join(privDir, "kid"), kid);
  writeFileSync(path.join(pubDir, "jwks.json"), JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] }));
  process.stdout.write("rehearsal issuer key generated (private key stays in the build workspace)\n");
} else if (cmd === "mint") {
  const [privDir, issuer, audience, email, out, flag] = rest;
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: issuer, aud: audience, sub: email, email, email_verified: true, iat: now - 30, exp: flag === "--expired" ? now - 600 : now + 3600 };
  const head = b64({ alg: "RS256", typ: "JWT", kid: readFileSync(path.join(privDir, "kid"), "utf8") });
  const body = b64(claims);
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  writeFileSync(out, `${head}.${body}.${signer.sign(readFileSync(path.join(privDir, "key.pem"), "utf8")).toString("base64url")}`, { mode: 0o600 });
  if (flag === "--unsigned") writeFileSync(out, `${b64({ alg: "none", typ: "JWT" })}.${body}.`, { mode: 0o600 });
  process.stdout.write(`token minted for audience ${audience}${flag ? ` (${flag})` : ""}\n`);
} else {
  process.stderr.write("usage: rehearsal-issuer.mjs keys <private dir> <public dir> | mint <private dir> <issuer> <audience> <email> <out> [--expired|--unsigned]\n");
  process.exit(2);
}
