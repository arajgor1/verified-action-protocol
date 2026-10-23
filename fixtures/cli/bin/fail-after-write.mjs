// Registered fixture command: writes a partial file, then fails.
import { writeFileSync } from "node:fs";
writeFileSync("partial.txt", "half written\n");
process.stderr.write("simulated failure after partial write\n");
process.exit(3);
