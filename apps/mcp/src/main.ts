import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { tokenFromEnv, VapClient } from "@verified-action-protocol/sdk";
import { createBridge } from "./bridge.js";

// stdio MCP bridge. Runs in the authorized cloud development environment and obtains VAP
// authentication from the configured workload identity (VAP_TOKEN_SOURCE=gcp-metadata).
// Logs go to stderr; stdout carries only the MCP protocol.
const url = process.env.VAP_URL;
if (!url) {
  process.stderr.write("VAP_URL is required\n");
  process.exit(2);
}
const client = new VapClient({ baseUrl: url, token: tokenFromEnv(), userAgent: "vap-mcp-stdio/0.1.0-rc.1" });
const server = createBridge(client);
await server.connect(new StdioServerTransport());
process.stderr.write(JSON.stringify({ severity: "INFO", message: "vap mcp bridge ready" }) + "\n");
