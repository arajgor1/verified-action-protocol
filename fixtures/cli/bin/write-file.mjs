// Registered fixture command: writes <content> to <relative path> inside the workspace.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const [rel, content] = process.argv.slice(2);
if (!rel || content === undefined) {
  process.stderr.write("usage: write-file <path> <content>\n");
  process.exit(2);
}
mkdirSync(dirname(rel), { recursive: true });
writeFileSync(rel, content.endsWith("\n") ? content : content + "\n");
process.stdout.write(JSON.stringify({ wrote: rel, bytes: Buffer.byteLength(content) }) + "\n");
