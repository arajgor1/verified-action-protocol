# Announcement draft: VAP 0.1.0-rc.1 (not posted)

> Draft for the owner. Nothing has been posted. Replace `<repository URL>` once the repository is
> public.

---

**VAP 0.1.0-rc.1: an experimental execution layer for agent actions that must not double-fire**

When an agent's API call times out, did the action happen? VAP (Verified Action Protocol) is an
experimental, open source runtime that answers that honestly. Actions are planned, run under
explicit grants, recorded durably, verified with read-back checks, and reconciled before any
retry. If the outcome cannot be established, VAP says `unknown` instead of guessing.

What we measured, and how:
- A 180-run comparison across nine failure scenarios, using **scripted policies against a
  synthetic GitHub-like fixture** (not models, not real GitHub). Naive retry produced duplicates
  in 35 of 45 runs. **A careful client with its own durable intent log matched VAP in every
  outcome category.** VAP's value is packaging that discipline once, behind one protocol, SDK and
  MCP bridge, not beating a well-built client.
- **Overhead is real:** about 0.7 s against about 0.2 s on the normal path, for the plan, journal
  writes and two verification reads.
- A **managed deployment on Google Cloud** (Cloud Run, Cloud Run jobs, Cloud Scheduler, Cloud SQL,
  Google-signed authentication) survived an interruption while verification was in flight,
  reconciled a lost reply, and kept its journal across API and database restarts.

Not done yet: runs against real GitHub, and any comparison with Claude or other models.

This is an **experimental core release candidate**: protocol 0.1 may change, the browser adapter
is excluded, and installation assumes a preconfigured Google Cloud project. Feedback on the
protocol and adapter contracts is very welcome: <repository URL>
