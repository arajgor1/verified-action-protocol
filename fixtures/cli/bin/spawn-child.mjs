// Registered fixture command: starts a child that outlives the parent, then exits.
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "const fs=require('fs');setInterval(()=>fs.writeFileSync('child-heartbeat.txt', String(Date.now())),200)"], {
  stdio: "ignore",
  detached: false,
});
child.unref();
process.stdout.write(JSON.stringify({ child_pid: child.pid }) + "\n");
setTimeout(() => process.exit(0), 300);
