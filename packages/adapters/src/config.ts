import { readFileSync } from "node:fs";
import path from "node:path";
import { AdapterRegistry } from "@verified-action-protocol/core";
import { BrowserAdapter } from "./browser-adapter.js";
import type { BrowserAdapterConfig } from "./browser-adapter.js";
import { CliAdapter } from "./cli-adapter.js";
import type { CliAdapterConfig } from "./cli-adapter.js";
import { GithubAdapter } from "./github-adapter.js";
import type { GithubAdapterConfig } from "./github-adapter.js";
import { HttpAdapter } from "./http-adapter.js";
import type { HttpAdapterConfig } from "./http-config.js";

/**
 * Deployment adapter configuration. Adapters are statically compiled into the image; this
 * file only selects and parameterises them. Nothing is downloaded and no code is loaded
 * from configuration.
 */
export interface AdaptersConfig {
  http?: HttpAdapterConfig[];
  cli?: CliAdapterConfig;
  browser?: BrowserAdapterConfig;
  github?: GithubAdapterConfig;
}

export interface BuildOptions {
  isolatedTestMode?: boolean;
  enableBrowser?: boolean;
  env?: Record<string, string | undefined>;
}

/**
 * Loads adapter configuration. Relative CLI script and template paths resolve against the
 * configuration file's directory. Deployment-specific values come from explicit
 * environment overrides, never from interpolation inside mappings:
 *   VAP_CONNECTOR_<NAME>_ORIGIN  overrides http connector <name>'s origin
 *   VAP_WORKSPACE_ROOT           overrides the CLI workspace root
 *   VAP_BROWSER_ORIGIN           overrides the browser adapter origin
 *   VAP_GITHUB_API_BASE_URL      overrides the GitHub adapter API base URL
 *   VAP_GITHUB_REPOSITORY        overrides the GitHub adapter repository (owner/repo)
 *   VAP_GITHUB_AUTHOR_LOGIN      overrides the account whose issues may satisfy a lookup
 */
export function loadAdaptersConfig(file: string, env: Record<string, string | undefined> = process.env): AdaptersConfig {
  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as AdaptersConfig;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("adapter configuration must be a JSON object");
  for (const k of Object.keys(parsed)) if (!["http", "cli", "browser", "github", "$comment"].includes(k)) throw new Error(`unknown adapter configuration key ${k}`);
  const base = path.dirname(path.resolve(file));
  for (const h of parsed.http ?? []) {
    for (const [name, c] of Object.entries(h.connectors)) {
      const o = env[`VAP_CONNECTOR_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_ORIGIN`];
      if (o) c.origin = o;
    }
  }
  if (parsed.cli) {
    if (env.VAP_WORKSPACE_ROOT) parsed.cli.workspace_root = env.VAP_WORKSPACE_ROOT;
    if (!path.isAbsolute(parsed.cli.workspace_root)) parsed.cli.workspace_root = path.resolve(base, parsed.cli.workspace_root);
    if (parsed.cli.template_dir && !path.isAbsolute(parsed.cli.template_dir)) parsed.cli.template_dir = path.resolve(base, parsed.cli.template_dir);
    for (const r of parsed.cli.recipes) if (r.script && !path.isAbsolute(r.script)) r.script = path.resolve(base, r.script);
  }
  if (parsed.browser && env.VAP_BROWSER_ORIGIN) parsed.browser.origin = env.VAP_BROWSER_ORIGIN;
  if (parsed.github) {
    if (env.VAP_GITHUB_API_BASE_URL) parsed.github.api_base_url = env.VAP_GITHUB_API_BASE_URL;
    if (env.VAP_GITHUB_REPOSITORY) parsed.github.repository = env.VAP_GITHUB_REPOSITORY;
    if (env.VAP_GITHUB_AUTHOR_LOGIN) parsed.github.author_login = env.VAP_GITHUB_AUTHOR_LOGIN;
  }
  return parsed;
}

export function buildRegistry(config: AdaptersConfig, opts: BuildOptions = {}): AdapterRegistry {
  const registry = new AdapterRegistry();
  for (const h of config.http ?? []) registry.register(new HttpAdapter(h, { isolatedTestMode: opts.isolatedTestMode, env: opts.env }));
  if (config.cli) registry.register(new CliAdapter(config.cli));
  if (config.github) registry.register(new GithubAdapter(config.github, { isolatedTestMode: opts.isolatedTestMode, env: opts.env }));
  if (config.browser && opts.enableBrowser !== false) registry.register(new BrowserAdapter(config.browser, { isolatedTestMode: opts.isolatedTestMode }));
  return registry.freeze();
}
