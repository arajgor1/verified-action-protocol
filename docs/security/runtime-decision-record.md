# Runtime image: security decision record (0.1.0-rc.1)

**Owner decision (2026-10-28): accepted for the experimental release, for this exact image digest
only, under the deployment restrictions below.** The three "component absent" findings are
recorded as **not affected**. The six "conditionally unreachable" and three "present but not used"
findings are **accepted exceptions**: residual risk the owner accepts under stated conditions, not
proof that the image is safe. The acceptance does not extend to new findings or to any other
image. Review date: **2027-01-28**, or earlier on a reassessment trigger
([Owner decision](#owner-decision)).

| Item | Value |
|---|---|
| Image | `<registry>/vap/vap@sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849` (supported runtime image), built from `765be87` |
| Findings | Trivy HIGH/CRITICAL inventory of release `9fd981db`: 12 CVEs, **0 with a fix available** (the same 12 as the previous rc.1 image `sha256:b7ecf996…`, release `6bf1f9da`). Debian bookworm base with security updates applied at build time |
| Evidence | read-only inspection build `c1838d77` on this image, and `d56d4bae` and `3319422a` on the previous rc.1 image `sha256:b7ecf996…`, each run inside the image as its default user: installed package versions (dpkg), files present, setuid/setgid files, `/etc/fstab`, what `node` links (`ldd`) and maps (`/proc/self/maps`) after loading the runtime modules, process identity and capabilities |
| Image contents (hold however the container is launched, unless a root process inside it changes them) | no setuid/setgid files (the Dockerfile clears them and the build fails if any remain); `/etc/fstab` without user mount entries; no npm CLI; no Playwright |
| Image defaults (the launcher can override them) | user `node` (uid 1000), from `USER node`. The image cannot prevent a launch as root (`docker run --user 0`, Kubernetes `runAsUser: 0`), a root `docker exec -u 0`, added capabilities, `--privileged`, or host devices and mounts. It does not set `no_new_privs` |
| Managed deploy pipeline | Cloud Run services and jobs. The pipeline sets no user override, capabilities, privileged mode or host devices. The user the deployed containers ran as was not measured in Cloud Run |

**Categories used:**
- **Component absent:** the vulnerable code is not in the image.
- **Conditionally unreachable:** the vulnerable code is present but can only be reached under a
  precondition that the restrictions listed rule out.
- **Present but not used:** the vulnerable code is present and reachable in principle, but no VAP
  code path runs it. This is evidence about VAP's own code, not proof that untrusted input cannot
  reach the code: an operator-registered recipe, or a launch as root, can.

**Facts measured in the image** (inspection `d56d4bae` on the previous rc.1 image; `c1838d77` found the same installed package versions, no setuid/setgid files, no Playwright, uid 1000 with empty capability sets, the same libraries mapped by `node`, and no `Archive/Tar` or `perl-modules` in this image; the only file differences are the renamed package directory and recompiled application files):
- `node` 24.21.0 links only `libdl`, `libstdc++`, `libm`, `libgcc_s`, `libpthread` and `libc`, and
  after loading the API runtime and `pg` it maps nothing else. It uses its bundled zlib
  (`1.3.2.1-motley`) and OpenSSL 3.5.8, not the system libraries.
- No setuid or setgid file exists (the previous image had 12, including `mount`, `umount` and
  `su`).
- `/etc/fstab` is the base system's unconfigured file: no `user` or `users` mount entries.
- Under a plain `docker run` in Cloud Build (no user, capability or device options) the process
  runs as uid 1000 with empty inheritable, permitted, effective and ambient capability sets,
  Docker's default bounding set and seccomp filter, and `no_new_privs` unset. This is the default
  launch, not something the image guarantees. File capabilities were not inspected.
- Not installed: `libminizip`, `systemd`, `systemd-homed` (`homectl`), any `perl-modules`
  package; no `Archive/Tar` file exists. Present: `mount`, `umount`, `nsenter`, `blkid`, `gzip`,
  `perl` (perl-base), `bash`, `infocmp`, `tic`.

## Decisions

| CVE (severity) | Package, installed version | Vulnerable functionality | Category and evidence | Restrictions the assessment relies on | Held by the image itself? | Reviewer's recommendation; follow-up trigger |
|---|---|---|---|---|---|---|
| CVE-2023-45853 (CRITICAL) | zlib1g 1:1.2.13.dfsg-1 | integer overflow in MiniZip's `zipOpenNewFileInZip4_64` when writing a ZIP entry with a long name, comment or extra field | **Component absent.** MiniZip is not part of Debian's `zlib1g`; `libminizip` is not installed; the system `libz.so.1` contains no `zipOpenNewFileInZip` symbol; `node` does not link or map the system libz | none | not needed | Not affected. Trigger: any package that ships or links MiniZip is added |
| CVE-2026-16742 (HIGH) | libsystemd0, libudev1 252.39-1~deb12u2 | local privilege escalation in `systemd-homed` (unsigned home records) | **Component absent.** Only the client libraries are installed; no `systemd`, `systemd-homed` or `homectl`; no init system runs in the container | none | not needed | Not affected. Trigger: systemd or systemd-homed is installed in the image |
| CVE-2026-9538 (HIGH) | perl-base 5.36.0-7+deb12u4 | memory exhaustion in Perl's `Archive::Tar` reading a crafted tar header | **Component absent.** `Archive::Tar` ships in `perl-modules-5.36`, which is not installed; no `Archive/Tar` file exists. `perl-base` is present only as a dpkg dependency | none | not needed | Not affected. Trigger: `perl-modules` is installed, or any tool runs Perl on untrusted archives |
| CVE-2026-53613 (HIGH) | mount, util-linux (and libmount1, libblkid1, bsdutils, libsmartcols1, libuuid1, util-linux-extra) 2.38.1-5+deb12u3 | TOCTOU in setuid `mount` for non-root mounts authorized by an fstab `user`/`users` entry | **Conditionally unreachable.** Needs setuid `mount` and an fstab user entry; the image has neither (setuid cleared; unconfigured fstab). VAP never runs `mount` | no setuid bit on `mount`; no fstab user entries; the container runs as non-root | **Yes, for the setuid and fstab preconditions** (image contents). Non-root is a launch default only; a root launch makes these escalation bugs moot rather than reachable, but removes the non-root boundary other rows rely on | Accept with restrictions. Trigger: a Debian fix (rebuild), or any change that restores setuid bits, adds fstab entries or runs the container as root |
| CVE-2026-76642 (HIGH) | as above | failed mount helper still runs privileged `X-mount.*` post-hooks | **Conditionally unreachable**, same preconditions (privileged `mount` invoked by an unprivileged user with fstab-authorized options) | as above | **Yes**, as above | as above |
| CVE-2026-78409 (HIGH) | as above | `X-mount.subdir` resolution escapes through intermediate symlinks (fstab-authorized, kernel 6.15+) | **Conditionally unreachable**, same preconditions | as above | **Yes**, as above | as above |
| CVE-2026-78410 (HIGH) | as above | restricted bind mounts do not pin the source, redirecting setuid `mount` | **Conditionally unreachable**, same preconditions | as above | **Yes**, as above | as above |
| CVE-2026-78408 (HIGH) | as above | `nsenter --join-cgroup` run by root leaks cgroup-migration authority to the target | **Conditionally unreachable.** Needs a privileged operator to run `nsenter --join-cgroup` into an attacker-controlled target; VAP never runs `nsenter`, and the container has no capabilities to enter namespaces | no one runs `nsenter` as root against this container; the container is not given `CAP_SYS_ADMIN` | **No.** Non-root and no `CAP_SYS_ADMIN` are launch defaults (`USER node`) that the launcher can override; host-side `nsenter` use is outside the image | Accept with restrictions. Trigger: a Debian fix, or operational procedures that use `nsenter` into VAP containers |
| CVE-2026-53615 (HIGH) | as above (libblkid1) | integer overflow in libblkid's DOS extended-partition parser when probing a crafted disk image or medium | **Conditionally unreachable.** Needs something to probe an attacker-supplied block device or image; VAP never runs `blkid` or links libblkid (`node` does not map it), and the container has no block devices | no block devices or disk images from untrusted sources are passed to the container; no CLI recipe runs `blkid`, `mount` or partition tools | **No.** Block devices are a launch setting (the managed pipeline passes none); the CLI-recipe rule is operator configuration (no shipped recipe runs these tools) | Accept with restrictions. Trigger: a Debian fix, a deployment that mounts devices, or a CLI recipe that runs these tools |
| CVE-2025-69720 (HIGH) | ncurses-bin, ncurses-base, libtinfo6 6.4-4 | stack buffer overflow in the `infocmp` tool (`analyze_string`) on crafted terminfo input | **Present but not used.** `infocmp` is installed; VAP never runs it, and `node` does not link libtinfo | no CLI recipe runs `infocmp` or other terminfo tools on untrusted input | **No** (operator configuration; no shipped recipe runs it) | Accept with restriction 2 (detail below). Trigger: a Debian fix, or a CLI recipe that runs terminal tools |
| CVE-2026-41992 (HIGH) | gzip 1.12-1 | global buffer overflow (information disclosure) decompressing crafted LZW then LZH input in one invocation | **Present but not used.** `gzip` is installed; VAP never runs it (`node` uses its bundled zlib) | no CLI recipe runs `gzip`, its wrappers or `tar` on compressed untrusted input | **No** (operator configuration) | Accept with restriction 2 (detail below); removing `gzip` is practical in a later image. Trigger: a Debian fix, or a CLI recipe that decompresses untrusted data |
| CVE-2026-54369 (HIGH) | libacl1 2.3.1-3 | symlink traversal in libacl pathname functions called by a **privileged** process | **Present but not used.** `node` neither links nor maps libacl; under the default launch no privileged process runs in the container (uid 1000, no capabilities, no setuid files) | the container runs as non-root without setuid binaries, and nothing runs in it as root | **No.** No setuid files is image contents; non-root is a launch default that the launcher can override | Accept with restriction 1 (detail below). Trigger: a Debian fix, or the container running as root |

## "Present but not used": detail per CVE

Sources: the scanner report of release `9fd981db` (Debian 12.15), inspection `c1838d77`, and the
source at the release commit. Debian package relationships (Essential packages, dependencies) are
from Debian's package metadata, not measured in the image. No image was rebuilt to test a removal.

**CVE-2025-69720** (ncurses; Debian status `affected`)
- **Installed component:** the `infocmp` program (`/usr/bin/infocmp`, package `ncurses-bin`
  6.4-4). The scanner also lists `libtinfo6` and `ncurses-base` 6.4-4, from the same source
  package; the vulnerable function (`analyze_string` in `progs/infocmp.c`) is in the program, not
  the library.
- **Prerequisites:** someone runs `infocmp` on terminfo data an attacker controls. Local, and
  the program must be run (CVSS AV:L, UI:R).
- **Evidence:** `infocmp` and `tic` are present; `node` neither links nor maps libtinfo; the
  entrypoint is `tini -- node`; the only process-execution path in the API and worker is an
  operator-registered CLI recipe, and the shipped recipes run only `node`.
- **Reachable through:** a recipe that runs `infocmp` or other terminfo tools on agent-supplied
  input. The runtime does not refuse such a recipe.
- **Removal:** deleting `/usr/bin/infocmp` (or force-removing `ncurses-bin`, an Essential package)
  removes the vulnerable code, and nothing in the shipped runtime runs it. It would not clear the
  finding: `libtinfo6` and `ncurses-base` stay installed (`bash` depends on `libtinfo6`).

**CVE-2026-41992** (gzip; Debian status `fix_deferred`)
- **Installed component:** `gzip` 1.12-1 (`/bin/gzip`, and the wrappers in the same package that
  run it: `gunzip`, `zcat`, `zgrep`, `zless`, `zmore`, `zdiff`, `uncompress` and others).
- **Prerequisites:** `gzip -d` decompresses a crafted LZW input followed by a crafted LZH input
  in one invocation. The result is an out-of-bounds read of a global buffer that can leak memory
  of that `gzip` process into its output (information disclosure). Whether a single crafted
  stream, as `zcat` or `tar` passes it, also triggers it is not established here, so any `gzip`
  decompression of untrusted data counts.
- **Evidence:** `node` decompresses with its bundled zlib (`1.3.2.1-motley`); no VAP source path
  runs `gzip`; the shipped recipes run only `node`.
- **Reachable through:** a recipe that runs `gzip -d`, one of its wrappers, or `tar` on a
  compressed archive (GNU `tar` runs `gzip` for such archives) on agent-supplied data. The memory
  at risk is that short-lived process's; the CLI adapter starts it with a fixed environment
  (`PATH`, `HOME`, `TMPDIR`, `LANG`), not the VAP process's.
- **Removal:** practical for the runtime, since nothing in it runs `gzip`. `gzip` is an Essential
  package, so the Dockerfile would need a forced `dpkg` removal; removing it through `dpkg` also
  clears the finding. It needs a rebuild, the full suite and a new scan (a new candidate).

**CVE-2026-54369** (acl; Debian status `fix_deferred`)
- **Installed component:** `libacl1` 2.3.1-3 (`/usr/lib/x86_64-linux-gnu/libacl.so.1`).
- **Prerequisites:** a privileged process (root, or one holding file-permission capabilities)
  calls `acl_get_file`, `acl_set_file`, `acl_extended_file` or `acl_delete_def_file` on a path in
  which the attacker can replace a component with a symlink (CVSS AV:L, PR:L).
- **Evidence:** `node` neither links nor maps libacl; under the default launch the process is uid
  1000 with no capabilities and the image has no setuid files, so there is no privileged caller.
- **Reachable through:** a launch or exec as root. A recipe or an operator command that then runs
  a program using libacl (`coreutils`, `tar` and `sed` depend on it) on agent-writable paths, such
  as the workspace directory, would be a privileged caller. Which of those programs call these
  functions on such paths was not measured.
- **Removal:** not practical within Debian: `coreutils`, `tar` and `sed`, all Essential, depend on
  it. The runtime itself (`tini`, `node`) does not use them, so a base image without them would
  remove it; that is a new candidate with a rebuild, the full suite and a new scan, and it also
  removes the shell and tools operators use for diagnosis.

## Reachability evidence for "present but not used" and "conditionally unreachable"

"Not used" alone does not show that untrusted input cannot reach the code, so the record relies
on the following facts about how a process in the image can come to run these binaries. They are
from the source at the release commit (`git grep` for `child_process`, `spawn`, `exec`, and
`shell: true` across `packages`, `apps` and `fixtures`) and from the inspection above:
- **The only process-execution path in the API and worker is the registered-command CLI adapter**
  (`packages/adapters/src/cli-adapter.ts`). It starts only the executable fixed in an
  operator-registered recipe (an absolute path, or `node` for the runtime's own binary), with
  `shell: false`, a fixed `PATH` and environment, and arguments that must match the recipe's typed
  argument schema. An agent or API caller chooses a recipe and argument values; it cannot name an
  executable, add arguments or reach a shell.
- The other `child_process` uses are in the SDK: the `vap` CLI, and the `gcloud` token provider,
  which runs only the fixed command `gcloud` (absent from the image). The API and worker do not
  depend on the SDK; the MCP bridge does, and runs `gcloud` only when configured with
  `VAP_TOKEN_SOURCE=gcloud`.
- The shipped configurations (`examples/config/*.json`) register only `node` with fixture scripts;
  one fixture script (`spawn-child.mjs`) starts another `node` process. None runs `gzip`,
  `infocmp`, `tic`, `mount`, `nsenter`, `blkid` or partition tools.
- `node` decompresses with its bundled zlib (`zlib` module), never the `gzip` binary, and does not
  link libtinfo, libblkid or libmount.

So reaching `gzip`, `infocmp`, `nsenter` or `blkid` requires either an operator to register a
recipe that runs them on untrusted input, or code execution inside the container already, which
gives an attacker more than these CVEs would. The first is a configuration restriction the image
does not enforce (below); the runtime does not refuse such a recipe.

## Deployment restrictions that are not enforced by the image

Every deployment of this image must keep these. They are conditions of the owner's acceptance:
a deployment that breaks one is outside the accepted risk, and the assessments above for the
affected rows no longer hold.
1. Launch the container as its default non-root user, without added capabilities, `--privileged`
   or host devices, and do not run processes in it as root (for example `docker exec -u 0`). The
   image sets the non-root user only as a default; it cannot stop a launcher from overriding it.
2. Do not register CLI recipes that run `mount`, `nsenter`, `blkid`, partition tools, `gzip` or
   its wrappers (`gunzip`, `zcat`, `zgrep` and the like), `tar` on compressed archives, or terminfo
   tools (`infocmp`, `tic`) on untrusted input (the shipped example configurations register none
   of them).
3. Do not use `nsenter` from the host into VAP containers as part of operations.
4. Do not pass block devices or disk images from untrusted sources to the container.

"Untrusted input" means anything an agent, an API caller or a remote destination can influence:
recipe arguments, files in a workspace, downloaded archives. A recipe that runs only a fixed
program on operator-controlled files is not affected by restriction 2.

Adding `--security-opt no-new-privileges` (Compose: `security_opt: ["no-new-privileges:true"]`)
and dropping all capabilities (`--cap-drop ALL`) is recommended; the quickstart Compose file does
both, and its cloud check confirms uid 1000, an empty effective capability set and
`NoNewPrivs: 1` in the running containers.

## Follow-up for every row

Rebuild and rescan when Debian publishes a fix (the release gate fails on any fixable
HIGH/CRITICAL finding, as it did for `zod` CVE-2023-54404 before `zod` was raised to 4.6.7).
Re-run the inspection whenever the base image or the Dockerfile changes.

## Owner decision

Recorded from the owner's explicit statement of 2026-10-28. Each category was decided separately.

| Item | Decision |
|---|---|
| Scope | runtime image `sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849` only, for the experimental release `0.1.0-rc.1`. Not the worker-browser image, not any rebuilt or later image, not findings that are not in the table above |
| "Component absent" (3: CVE-2023-45853, CVE-2026-16742, CVE-2026-9538) | **not affected**, on the evidence in each row (absence measured in this image by inspections `d56d4bae` and `c1838d77`) |
| "Conditionally unreachable" (6: CVE-2026-53613, -76642, -78409, -78410, -78408, -53615) | **accepted exception**, conditional on restrictions 1 to 4 |
| "Present but not used" (3: CVE-2025-69720, CVE-2026-41992, CVE-2026-54369) | **accepted exception**, conditional on restriction 2 (`infocmp`, `gzip`) and restriction 1 (`libacl1`). Not a finding that the code is unreachable |
| Required deployment conditions | the image's non-root user; no privileged mode; no added capabilities; no host devices; no root commands inside the container; the recipe and untrusted-input restrictions above |
| Review date | 2027-01-28 |
| Reassessment triggers | a fix becomes available for any of the 12 findings (rebuild and rescan); applicability changes (a new finding, a package added or removed, a change to the Dockerfile or base image, a shipped recipe that runs an affected tool); the supported deployment conditions change (for example a deployment path that runs as root or with added privileges) |

Removing `gzip` (CVE-2026-41992) is practical in a later image and is recorded as a follow-up,
not a condition of this release.
