import { DemoAuthenticator, OidcAuthenticator } from "./auth.js";
import type { Authenticator } from "./auth.js";
import { loadConfig } from "./config.js";
import { createRuntime } from "./runtime.js";
import { createApiServer } from "./server.js";

const cfg = loadConfig();
const rt = await createRuntime(cfg);
const auth: Authenticator = cfg.authMode === "demo" ? new DemoAuthenticator() : new OidcAuthenticator(rt.journal, cfg.oidcIssuer, cfg.oidcAudience!, cfg.oidcJwksUrl);
const server = createApiServer({
  coordinator: rt.coordinator,
  auth,
  log: rt.log,
  limits: {
    maxRequestBytes: cfg.maxRequestBytes,
    maxInFlight: cfg.maxInFlight,
    perPrincipalRps: cfg.perPrincipalRps,
    requestKeyRetentionSeconds: Math.floor(rt.coordinator.opts.requestKeyRetentionMs / 1000),
  },
  build: { version: cfg.buildVersion, commit: cfg.buildCommit, image_digest: cfg.imageDigest },
  ready: () => rt.journal.ping(),
});
server.requestTimeout = 120_000;
server.headersTimeout = 15_000;
server.listen(cfg.port, cfg.host, () => {
  rt.log.info("vap api listening", { host: cfg.host, port: cfg.port, auth_mode: cfg.authMode, dispatch_mode: cfg.dispatchMode, env: cfg.env });
});
const shutdown = () => {
  rt.log.info("shutting down");
  server.close(() => {
    rt.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
