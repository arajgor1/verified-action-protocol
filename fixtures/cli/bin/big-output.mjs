// Registered fixture command: emits <bytes> of output to exercise output caps.
const total = Number(process.argv[2] ?? 1048576);
const line = "x".repeat(1023) + "\n";
let written = 0;
function pump() {
  while (written < total) {
    written += line.length;
    if (!process.stdout.write(line)) {
      process.stdout.once("drain", pump);
      return;
    }
  }
}
pump();
