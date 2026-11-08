# SDK example (npm packages)

The packages are published on npm under the `@verified-action-protocol` scope. **Do not install
`@vap/*`:** that npm scope belongs to an unrelated publisher.

## Install

```bash
npm install @verified-action-protocol/sdk@0.1.0-rc.1 @verified-action-protocol/adapters@0.1.0-rc.1
```

Release candidates are published under the `next` dist-tag, so name the version (or `@next`).
Node.js 24 is required. This installs the client, the adapter SDK, the `vap` CLI and the HTTP and
registered-command adapters, with no browser automation: `playwright` is only an optional peer
dependency of `@verified-action-protocol/adapters`, npm does not install it, and nothing downloads
browser binaries. The experimental browser adapter is not part of the supported release. Add
`@verified-action-protocol/store-postgres` only to run your own journal.

## Run the example

[`examples/sdk/offline-check.mjs`](../examples/sdk/offline-check.mjs) loads a declarative adapter
configuration, freezes it into a registry (every action descriptor is validated against the
protocol schemas), runs static conformance on each adapter and computes a canonical digest. It
needs no deployed API, database or cloud credentials:

```bash
node offline-check.mjs adapters.tutorial.json
```

with [`examples/config/adapters.tutorial.json`](../examples/config/adapters.tutorial.json) next
to it. With `VAP_URL` (and `VAP_TOKEN_SOURCE`/`VAP_AUDIENCE`, as for the `vap` CLI) pointing at a
deployed API, it also calls `info()` on that API.

TypeScript users get the published declarations; they type-check without `playwright` installed
([`examples/sdk/typecheck.ts`](../examples/sdk/typecheck.ts)).

## How this is tested

The release pipeline (`bash scripts/vap-cloud.sh release`) installs the exact release tarballs
into an empty consumer project, in a fresh directory with its own home directory and npm cache,
and with registry lookups for the scope blocked so nothing can resolve to another publisher's
package ([`scripts/consumer-install.sh`](../scripts/consumer-install.sh)). It fails if Playwright,
its browser cache or Chromium appears, runs the example above, and type-checks
`typecheck.ts` with `skipLibCheck` off.

That test installs **local tarballs** and runs the example **offline**: the client call against a
deployed API is skipped. The quickstart's `connect` service covers the public path: it installs
the SDK from the npm registry and takes one action to `verified` against the quickstart runtime.
