# Runtime image: security decision record (0.1.0-rc.1)

**This is the security reviewer's recommendation, not the owner's acceptance.** Accepting the
residual risk of each finding below is the owner's decision and is **pending**.

| Item | Value |
|---|---|
| Image | `<registry>/vap/vap@sha256:b7ecf996a9a8c0731cc251b0cd891510a66c40a4f587cb219a38760cea0a9467` (supported runtime image), built from `fb49426` |
| Findings | Trivy HIGH/CRITICAL inventory of release `6bf1f9da`: 12 CVEs, **0 with a fix available**. Debian bookworm base with security updates applied at build time |
| Evidence | read-only inspection build `d56d4bae` (and `3319422a`) that ran inside the image as its default user: installed package versions (dpkg), files present, setuid/setgid files, `/etc/fstab`, what `node` links (`ldd`) and maps (`/proc/self/maps`) after loading the runtime modules, process identity and capabilities |
| Shipped configuration | Dockerfile: runs as `node` (uid 1000); setuid/setgid bits cleared (the build fails if any remain); no npm CLI; no Playwright. Managed deploy pipeline: Cloud Run services and jobs, no privileged mode, no host devices |

**Categories used:**
- **Component absent:** the vulnerable code is not in the image.
- **Conditionally unreachable:** the vulnerable code is present but can only be reached under a
  precondition that the restrictions listed rule out.
- **Present but not used:** the vulnerable code is present and reachable in principle, but no VAP
  code path runs it.

**Facts measured in the image (inspection `d56d4bae`):**
- `node` 24.21.0 links only `libdl`, `libstdc++`, `libm`, `libgcc_s`, `libpthread` and `libc`, and
  after loading the API runtime and `pg` it maps nothing else. It uses its bundled zlib
  (`1.3.2.1-motley`) and OpenSSL 3.5.8, not the system libraries.
- No setuid or setgid file exists (the previous image had 12, including `mount`, `umount` and
  `su`).
- `/etc/fstab` is the base system's unconfigured file: no `user` or `users` mount entries.
- The process runs as uid 1000 with empty permitted and effective capability sets.
- Not installed: `libminizip`, `systemd`, `systemd-homed` (`homectl`), any `perl-modules`
  package; no `Archive/Tar` file exists. Present: `mount`, `umount`, `nsenter`, `blkid`, `gzip`,
  `perl` (perl-base), `bash`, `infocmp`, `tic`.

## Decisions

| CVE (severity) | Package, installed version | Vulnerable functionality | Category and evidence | Restrictions the assessment relies on | Enforced by shipped configuration? | Reviewer's recommendation; follow-up trigger |
|---|---|---|---|---|---|---|
| CVE-2023-45853 (CRITICAL) | zlib1g 1:1.2.13.dfsg-1 | integer overflow in MiniZip's `zipOpenNewFileInZip4_64` when writing a ZIP entry with a long name, comment or extra field | **Component absent.** MiniZip is not part of Debian's `zlib1g`; `libminizip` is not installed; the system `libz.so.1` contains no `zipOpenNewFileInZip` symbol; `node` does not link or map the system libz | none | not needed | Not affected. Trigger: any package that ships or links MiniZip is added |
| CVE-2026-16742 (HIGH) | libsystemd0, libudev1 252.39-1~deb12u2 | local privilege escalation in `systemd-homed` (unsigned home records) | **Component absent.** Only the client libraries are installed; no `systemd`, `systemd-homed` or `homectl`; no init system runs in the container | none | not needed | Not affected. Trigger: systemd or systemd-homed is installed in the image |
| CVE-2026-9538 (HIGH) | perl-base 5.36.0-7+deb12u4 | memory exhaustion in Perl's `Archive::Tar` reading a crafted tar header | **Component absent.** `Archive::Tar` ships in `perl-modules-5.36`, which is not installed; no `Archive/Tar` file exists. `perl-base` is present only as a dpkg dependency | none | not needed | Not affected. Trigger: `perl-modules` is installed, or any tool runs Perl on untrusted archives |
| CVE-2026-53613 (HIGH) | mount, util-linux (and libmount1, libblkid1, bsdutils, libsmartcols1, libuuid1, util-linux-extra) 2.38.1-5+deb12u3 | TOCTOU in setuid `mount` for non-root mounts authorized by an fstab `user`/`users` entry | **Conditionally unreachable.** Needs setuid `mount` and an fstab user entry; the image has neither (setuid cleared; unconfigured fstab). VAP never runs `mount` | no setuid bit on `mount`; no fstab user entries; the container runs as non-root | **Yes** (Dockerfile clears setuid and the build checks it; base fstab; `USER node`) | Accept with restrictions. Trigger: a Debian fix (rebuild), or any change that restores setuid bits, adds fstab entries or runs the container as root |
| CVE-2026-76642 (HIGH) | as above | failed mount helper still runs privileged `X-mount.*` post-hooks | **Conditionally unreachable**, same preconditions (privileged `mount` invoked by an unprivileged user with fstab-authorized options) | as above | **Yes** | as above |
| CVE-2026-78409 (HIGH) | as above | `X-mount.subdir` resolution escapes through intermediate symlinks (fstab-authorized, kernel 6.15+) | **Conditionally unreachable**, same preconditions | as above | **Yes** | as above |
| CVE-2026-78410 (HIGH) | as above | restricted bind mounts do not pin the source, redirecting setuid `mount` | **Conditionally unreachable**, same preconditions | as above | **Yes** | as above |
| CVE-2026-78408 (HIGH) | as above | `nsenter --join-cgroup` run by root leaks cgroup-migration authority to the target | **Conditionally unreachable.** Needs a privileged operator to run `nsenter --join-cgroup` into an attacker-controlled target; VAP never runs `nsenter`, and the container has no capabilities to enter namespaces | no one runs `nsenter` as root against this container; the container is not given `CAP_SYS_ADMIN` | **Partly.** `USER node` and empty capability sets are shipped; an operator's own host-side `nsenter` use is outside the image | Accept with restrictions. Trigger: a Debian fix, or operational procedures that use `nsenter` into VAP containers |
| CVE-2026-53615 (HIGH) | as above (libblkid1) | integer overflow in libblkid's DOS extended-partition parser when probing a crafted disk image or medium | **Conditionally unreachable.** Needs something to probe an attacker-supplied block device or image; VAP never runs `blkid` or links libblkid (`node` does not map it), and the container has no block devices | no block devices or disk images from untrusted sources are passed to the container; no CLI recipe runs `blkid`, `mount` or partition tools | **Partly.** Cloud Run exposes no host block devices; the CLI-recipe rule is operator configuration (no shipped recipe runs these tools) | Accept with restrictions. Trigger: a Debian fix, a deployment that mounts devices, or a CLI recipe that runs these tools |
| CVE-2025-69720 (HIGH) | ncurses-bin, ncurses-base, libtinfo6 6.4-4 | stack buffer overflow in the `infocmp` tool (`analyze_string`) on crafted terminfo input | **Present but not used.** `infocmp` is installed; VAP never runs it, and `node` does not link libtinfo | no CLI recipe runs `infocmp` or other terminfo tools on untrusted input | **No** (operator configuration; no shipped recipe runs it) | Accept. Trigger: a Debian fix, or a CLI recipe that runs terminal tools |
| CVE-2026-41992 (HIGH) | gzip 1.12-1 | global buffer overflow (information disclosure) decompressing crafted LZW then LZH input in one invocation | **Present but not used.** `gzip` is installed; VAP never runs it (`node` uses its bundled zlib) | no CLI recipe runs `gzip` on untrusted input | **No** (operator configuration) | Accept. Trigger: a Debian fix, or a CLI recipe that decompresses untrusted data with `gzip` |
| CVE-2026-54369 (HIGH) | libacl1 2.3.1-3 | symlink traversal in libacl pathname functions called by a **privileged** process | **Present but not used.** libacl is a dependency of coreutils; no privileged process runs in the container (uid 1000, no capabilities, no setuid files); VAP never calls ACL functions | the container runs as non-root without setuid binaries | **Yes** (`USER node`; setuid cleared) | Accept. Trigger: a Debian fix, or the container running as root |

## Deployment restrictions that are not enforced by the image

An operator who runs the image outside the managed pipeline must keep these, or the assessments
above for the affected rows no longer hold:
1. Do not run the container as root or with added capabilities, `--privileged` or host devices.
2. Do not register CLI recipes that run `mount`, `nsenter`, `blkid`, partition tools, `gzip` or
   terminfo tools on untrusted input (the shipped example configurations register none of them).
3. Do not use `nsenter` from the host into VAP containers as part of operations.
Adding `--security-opt no-new-privileges` on Docker hosts is recommended defense in depth.

## Follow-up for every row

Rebuild and rescan when Debian publishes a fix (the release gate fails on any fixable
HIGH/CRITICAL finding, as it did for `zod` CVE-2023-54404 before `zod` was raised to 4.6.7).
Re-run the inspection whenever the base image or the Dockerfile changes.

## Owner decision (pending)

| Decision | Status |
|---|---|
| Accept "component absent" findings (3) as not affecting the image | pending |
| Accept "conditionally unreachable" findings (6) with the restrictions above | pending |
| Accept "present but not used" findings (3) | pending |
