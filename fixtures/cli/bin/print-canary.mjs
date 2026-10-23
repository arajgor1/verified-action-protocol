// Registered fixture command for leakage tests: prints synthetic canary credentials to both
// streams and fails, so they would surface in output and error messages if not redacted.
process.stdout.write("token=Bearer VAPCANARY-cli-out-5a6b7c8d\n");
process.stderr.write("Authorization: Bearer VAPCANARY-cli-err-1a2b3c4d\n");
process.exit(1);
