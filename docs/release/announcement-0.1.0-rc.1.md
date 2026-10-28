# Announcement draft: VAP 0.1.0-rc.1 (not posted)

> Draft for the owner to post after publication, once the public check has passed (the README
> commands against the public image and npm packages; [quickstart-results.md](quickstart-results.md)).
> Every claim below is in the release notes with its evidence.

---

**VAP 0.1.0-rc.1: an experimental execution layer for agent actions, with honest outcomes**

When an agent's API call times out, did the action happen? VAP (Verified Action Protocol) is an
experimental, open source runtime that keeps that question explicit. Actions are prepared as
immutable plans, run under grants an operator issues, recorded in a durable journal, checked by
reading the result back, and reconciled before any retry. If the outcome cannot be established,
VAP reports `unknown` instead of guessing.

Try it with Docker, no accounts needed:

```bash
git clone https://github.com/arajgor1/verified-action-protocol.git && cd verified-action-protocol
docker compose -f examples/quickstart/compose.yaml run --rm demo
```

The demo drops a response after the destination has committed a write: VAP shows `unknown`,
reconciles, verifies, and the destination shows exactly one write. A second command connects the
TypeScript SDK (`@verified-action-protocol/sdk`) and takes one action to `verified`.

What we measured, and how:
- 180 runs across nine failure scenarios, with **scripted policies against a synthetic
  GitHub-like fixture** (not models, not real GitHub). VAP completed 35 of 35 completable runs
  with no duplicates and no false task success. **A careful client with its own durable intent
  log matched VAP in every outcome category.** VAP's value is packaging that discipline once,
  behind one protocol, SDK and MCP bridge, not beating a well-built client.
- **Overhead is real:** a median of about 0.7 s against about 0.2 s on the normal path, for the
  plan, journal writes and read-back checks.

Limits, stated plainly: protocol 0.1 may change; the browser adapter is excluded; the managed
Google Cloud deployment is experimental (on the final image it passed once and failed once, with
an unexplained 401 from Cloud Scheduler); nothing has run against real GitHub or been compared
with model-driven agents; the container image carries 12 unfixed upstream Debian CVEs, accepted
for this release only under documented deployment restrictions; there is no public build
provenance. The `@vap` scope on npm belongs to someone else.

Feedback on the protocol and adapter contracts is very welcome:
https://github.com/arajgor1/verified-action-protocol
