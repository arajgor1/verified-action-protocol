# Worker-browser image: technical security assessment

This page is a **technical assessment** of the shipped worker-browser image. **Accepting the
residual risk is the owner's decision, which is recorded separately below and is currently
pending.** Until it is accepted, the browser adapter and the worker-browser image are
**experimental** and outside the supported v0.1 release scope (see "Release scope").

## Evidence

Cloud Build `e333db2c-18cb-472b-bf3c-45e15f49dc41` (`bash scripts/vap-cloud.sh browser-linkage`)
ran `scripts/browser-linkage.mjs` inside the worker-browser image pulled by digest
`sha256:eb1a00875a1c9c039c1a380ee8a7872fa7127554d6e3a47fc946f95cf08a0628`, built from publication
candidate `61ed3b2` (revision label checked). It used that image's own Playwright 1.63 and
Chromium build 1243. The same inspection of the two previous builds (`a11ae226`, image
`sha256:1d2cd1e6…`, and `14de1812`, image `sha256:2eb3847d…`) gave identical linkage results.

It launched Chromium exactly as the browser adapter does: `headless: true`, with a proxy. It
rendered a page with text, SVG, a form input and a canvas, and ran `DOMParser` on an XML
document. It then read `/proc/<pid>/maps` of all six Chromium processes (browser, two zygotes,
GPU, utility, renderer). The output is `browser-linkage.json` in the evidence for that run.

**Facts established:**
- In headless mode Playwright runs **chrome-headless-shell**, not the full Chromium binary. The
  shared objects mapped while rendering are the ones that matter for the adapter. The full
  binary's static dependencies (`ldd`) are recorded too, for a non-headless launch, which the
  adapter never does.
- **Mapped while rendering:** glib/gio/gobject, libX11 and other X client libraries,
  libxkbcommon, NSS/NSPR, libdbus-1, libsystemd, libudev, libmount, libblkid, libz, expat, libdrm,
  libgbm, ATK/AT-SPI, ALSA, plus SwiftShader/Vulkan, which are bundled with Playwright.
- **Not mapped, and not linked by the full binary either:** the system **libsqlite3**,
  **libxml2** and **libssl3**. The XML parse in the page did not load the system libxml2.
- **Linked by the full binary but not mapped by the headless shell:** HarfBuzz, CUPS, GTK, Cairo,
  Pango.
- **Daemons:** an Xvfb binary is installed but not running; there is no D-Bus daemon binary and
  no D-Bus socket; there is no CUPS daemon.
- **Code presence:** the system libz contains no minizip symbols (0 matches for
  `zipOpenNewFileInZip`).

## Critical findings

| CVE | Package | Affected code path and exploit condition | Evidence in this image | Technical assessment |
|---|---|---|---|---|
| CVE-2023-45853 | zlib1g | Integer overflow in minizip's `zipOpenNewFileInZip4_6`; needs a program that calls minizip to write ZIP files with attacker-sized fields | libz is mapped, but **minizip is not in it** (0 symbols) | **Not applicable**: the vulnerable function is absent |
| CVE-2025-7458 | libsqlite3-0 | SQLite integer overflow; needs a process using the system SQLite to run attacker-influenced SQL | system libsqlite3 **neither linked nor mapped** by Chromium. Node.js bundles its own SQLite (not the system library; not separately inspected) | **Not loaded by Chromium**; installed only as a dependency. No VAP code path uses the system library |
| CVE-2026-58016 | libglib2.0-0 | Integer underflow in `gdbusintrospection.c`; needs parsing D-Bus introspection XML supplied by a D-Bus peer | glib/gio **mapped** in the Chromium processes. No D-Bus daemon or socket exists in the image | **Loaded, conditionally reachable.** It needs a D-Bus peer, and none is present in the tested configuration. **Not proven unreachable**: a deployment that mounts a D-Bus socket would change this. Residual risk: low, conditional |
| CVE-2026-6653 | libxml2 | Denial of service via crafted XML; needs a process using the system libxml2 to parse attacker XML | system libxml2 **neither linked nor mapped**, even while the page parsed XML | **Not loaded by Chromium**; installed only |

## High findings, by linkage

| Group | CVEs | Linkage | Assessment |
|---|---|---|---|
| X server (Xvfb, xserver-common) | 7 | binary installed, not running; the adapter never starts it | Not running; removable in a follow-up |
| libX11, libXrender (malicious X server) | 2 | mapped | Needs a connection to a malicious X server; headless Chromium connects to no X server. Loaded, no X server present: conditional |
| glib (other) | 6 | mapped | Over-reads and off-by-ones in GVariant, date/time, regex, IO-channel and key-file parsing; one D-Bus SHA1 auth path traversal. Reachability depends on Chromium passing attacker data to these specific glib functions, which this evaluation did not establish. **Unverified: treat as open risk** |
| libxml2 (other), libsqlite3 (FTS5), libssl3 (DTLS) | 9 | not linked, not mapped | Not loaded by Chromium |
| HarfBuzz, CUPS | 3 | not mapped by the headless shell | Not loaded in the adapter's headless use |
| systemd/udev, util-linux (libmount, libblkid) | 8 | libsystemd, libudev, libmount and libblkid mapped; mount, nsenter, homed and partition tools not used | The CVEs are in privileged tools (mount, nsenter), systemd-homed, or partition-table parsing of block devices. Chromium uses udev for device enumeration with no block devices to parse. Conditional: loaded, needs privileged tooling or attacker-supplied block devices |
| ncurses, gzip, perl, libacl | 4 | not linked, not mapped | Not used |

## Release scope (recommended)

- **Supported v0.1 artifacts:** the runtime image (API, worker, sweeper, migration job, fixture),
  the five npm packages, and the schema bundle. The runtime image contains no Chromium; the
  browser adapter is disabled unless `VAP_ENABLE_BROWSER=1` **and** Chromium is installed.
- **Experimental, not supported:** the browser adapter and the worker-browser image. They stay
  in the repository and are built, scanned and smoke-tested by the release pipeline. The image
  carries the label `vap.support=experimental`, and the runtime logs a warning when the adapter
  is enabled. Use them only with the adapter pointed at operator-trusted origins.

**What this changes for users:**
- Browser-based actions (form submission through Chromium, DOM read-back) are not part of the
  supported release.
- HTTP and registered-CLI actions, and everything in the CI-failure demo, are unaffected.
- The browser suite still runs in every full test build, so regressions stay visible.

## Owner acceptance

| Item | Status |
|---|---|
| Accept the conditional residual risk of CVE-2026-58016 (glib, D-Bus peer required) | **pending (owner)** |
| Accept the unverified glib HIGH findings, or require a fix or further analysis first | **pending (owner)** |
| Promote the browser adapter and worker-browser image to supported | **pending (owner)**; requires both items above |
