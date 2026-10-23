#!/usr/bin/env node
// Browser-image linkage evidence (infra/gcp/cloudbuild.browser-linkage.yaml). Runs INSIDE the
// shipped worker-browser image, with the image's own Playwright and Chromium. It records:
//   - which Chromium binary ships and its static (ldd) dependencies;
//   - which shared objects are actually mapped by every Chromium process while it renders a
//     page the way the browser adapter does (headless, through a proxy setting);
//   - for a given list of packages with open CVEs, whether their libraries are linked, mapped,
//     or only installed;
//   - whether specific vulnerable code is present at all (e.g. minizip symbols in libz);
//   - whether the X server, D-Bus or CUPS daemons exist or run.
//
//   node scripts/browser-linkage.mjs <out.json> <pkg,pkg,...>
import "./cloud-guard.ts";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const [out, pkgArg] = process.argv.slice(2);
const packages = (pkgArg ?? "").split(",").filter(Boolean);
const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};

// The image's own Playwright, not the workspace copy.
const require = createRequire("/app/package.json");
const { chromium } = require("playwright");
const exe = chromium.executablePath();

const lddOut = sh("ldd", [exe]).out;
const ldd = [...lddOut.matchAll(/=>\s+(\S+)\s+\(/g)].map((m) => m[1]);

// Render a page the way the adapter launches Chromium, then read every Chromium process's maps.
const browser = await chromium.launch({ headless: true, proxy: { server: "http://127.0.0.1:9", bypass: "<-loopback>" } });
const page = await browser.newPage();
await page.setContent("<!doctype html><title>t</title><h1>linkage</h1><svg><text>x</text></svg><input type=text><canvas></canvas>");
await page.evaluate(() => {
  const c = document.querySelector("canvas").getContext("2d");
  c.fillText("x", 1, 1);
  return new DOMParser().parseFromString("<a><b/></a>", "application/xml").documentElement.nodeName;
});
const mapped = new Set();
const procs = [];
for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
  let cmd = "";
  try {
    cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0];
  } catch {
    continue;
  }
  if (!cmd.includes("chrom") && !cmd.includes("headless_shell")) continue;
  procs.push({ pid: Number(pid), cmd: cmd.split("/").pop(), type: (readFileSync(`/proc/${pid}/cmdline`, "utf8").match(/--type=([a-z-]+)/) ?? [null, "browser"])[1] });
  try {
    for (const line of readFileSync(`/proc/${pid}/maps`, "utf8").split("\n")) {
      const m = /\s(\/\S+\.so[\.\d]*)\s*$/.exec(line);
      if (m) mapped.add(m[1]);
    }
  } catch {
    /* process exited */
  }
}
await browser.close();

const owner = (file) => {
  const r = sh("dpkg", ["-S", file]);
  return r.code === 0 ? r.out.split(":")[0].trim() : null;
};
const mappedList = [...mapped].sort();
const mappedByPkg = {};
for (const f of mappedList) {
  const p = owner(f) ?? (f.startsWith("/ms-playwright") ? "(bundled with Playwright Chromium)" : "(unowned)");
  (mappedByPkg[p] ??= []).push(f);
}

const perPackage = {};
for (const p of packages) {
  const files = sh("dpkg", ["-L", p]).out.split("\n").filter((f) => /\.so[\.\d]*$/.test(f));
  const installed = sh("dpkg-query", ["-W", "-f=${Status}", p]).out.includes("install ok installed");
  const bins = sh("dpkg", ["-L", p]).out.split("\n").filter((f) => /\/(s?bin)\//.test(f));
  perPackage[p] = {
    installed,
    libraries: files,
    linked_by_chromium: files.filter((f) => ldd.some((l) => l === f || l.endsWith("/" + f.split("/").pop()))),
    mapped_by_chromium: files.filter((f) => mappedList.some((m) => m === f || m.endsWith("/" + f.split("/").pop()))),
    executables: bins,
  };
}

const libz = ["/usr/lib/x86_64-linux-gnu/libz.so.1", "/lib/x86_64-linux-gnu/libz.so.1"].find((f) => existsSync(f));
const libzText = libz ? readFileSync(libz).toString("latin1") : "";
const running = readdirSync("/proc").filter((p) => /^\d+$/.test(p)).map((p) => { try { return readFileSync(`/proc/${p}/comm`, "utf8").trim(); } catch { return ""; } }).join("|");
const result = {
  chromium_executable: exe,
  ldd_dependencies: ldd.sort(),
  processes_inspected: procs,
  mapped_shared_objects: mappedByPkg,
  packages: perPackage,
  code_presence: {
    libz_path: libz ?? null,
    minizip_zipOpenNewFileInZip_symbols_in_libz: libz ? (libzText.match(/zipOpenNewFileInZip/g) ?? []).length : null,
  },
  daemons: {
    xvfb_binary: existsSync("/usr/bin/Xvfb"),
    xvfb_running: /Xvfb/.test(running),
    dbus_daemon_binary: existsSync("/usr/bin/dbus-daemon"),
    dbus_session_or_system_socket: existsSync("/run/dbus/system_bus_socket"),
    cupsd_binary: existsSync("/usr/sbin/cupsd"),
  },
  inspected_at: new Date().toISOString(),
};
writeFileSync(out, JSON.stringify(result, null, 2));
process.stdout.write(JSON.stringify({ chromium: exe, ldd: ldd.length, mapped: mappedList.length, processes: procs.length, packages: Object.fromEntries(Object.entries(perPackage).map(([k, v]) => [k, { installed: v.installed, linked: v.linked_by_chromium.length, mapped: v.mapped_by_chromium.length }])), code_presence: result.code_presence, daemons: result.daemons }, null, 1) + "\n");
