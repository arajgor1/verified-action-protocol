// Registered fixture command: asks for confirmation and waits. VAP must never answer.
import { writeFileSync } from "node:fs";
process.stdout.write("Deploy to production? [y/N] VAP_INPUT_REQUIRED\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  if (String(d).trim().toLowerCase() === "y") writeFileSync("approved-by-stdin.txt", "approved\n");
  process.exit(0);
});
setInterval(() => {}, 1000);
