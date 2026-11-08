// Registered fixture command: sleeps for <ms> milliseconds (timeout tests).
const ms = Number(process.argv[2] ?? 1000);
setTimeout(() => process.exit(0), ms);
