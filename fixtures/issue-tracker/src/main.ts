import { startFixture } from "./server.js";

const databaseUrl = process.env.FIXTURE_DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write("FIXTURE_DATABASE_URL is required\n");
  process.exit(2);
}
const testControls = process.env.FIXTURE_TEST_CONTROLS === "1";
const handle = await startFixture({
  databaseUrl,
  host: process.env.FIXTURE_HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? process.env.FIXTURE_PORT ?? 8081),
  testControls,
  controlHost: process.env.FIXTURE_CONTROL_HOST ?? "127.0.0.1",
  controlPort: Number(process.env.FIXTURE_CONTROL_PORT ?? 8082),
});
process.stdout.write(JSON.stringify({ severity: "INFO", message: "issue-tracker fixture listening", url: handle.url, test_controls: testControls }) + "\n");
const stop = () => {
  handle.close().finally(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
