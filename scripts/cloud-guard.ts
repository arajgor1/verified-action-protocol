// Execution boundary guard. Project scripts, tests, benchmarks and demos run only inside the
// cloud pipelines in infra/gcp/, which set VAP_CLOUD_EXECUTION=1 for every step. Anywhere else
// they refuse to start, so a workstation is never used as a fallback when the cloud is
// unavailable (report the gate as BLOCKED instead). This is a guard against accidents, not a
// security boundary: anyone can set the variable.
if (process.env.VAP_CLOUD_EXECUTION !== "1") {
  process.stderr.write(
    "refusing to run outside a VAP cloud build: VAP_CLOUD_EXECUTION=1 is set only by infra/gcp/cloudbuild.*.yaml. " +
      "Submit the work with `bash scripts/vap-cloud.sh test --suite <suite>` instead of running it locally.\n",
  );
  process.exit(3);
}

export {};
