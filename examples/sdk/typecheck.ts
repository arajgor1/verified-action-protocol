// Type-level consumer check for the published declarations (docs/sdk-example.md): compiled with
// skipLibCheck off in a project that has no playwright installed.
import { buildRegistry, loadAdaptersConfig } from "@verified-action-protocol/adapters";
import type { AdaptersConfig } from "@verified-action-protocol/adapters";
import type { Operation, TaskOutcome } from "@verified-action-protocol/protocol";
import { staticConformance, staticToken, VapClient } from "@verified-action-protocol/sdk";

export async function check(file: string, baseUrl: string): Promise<[number, Operation | null, TaskOutcome | null]> {
  const config: AdaptersConfig = loadAdaptersConfig(file);
  const registry = buildRegistry(config, { enableBrowser: false });
  let findings = 0;
  for (const adapter of registry.adapters()) findings += (await staticConformance(adapter)).length;
  const client = new VapClient({ baseUrl, token: staticToken("example") });
  return [findings, await client.findOperation("issues.set_status", "example-key"), null];
}
