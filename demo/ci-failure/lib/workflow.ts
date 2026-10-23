// Logical workflow identity for "a failed build becomes one GitHub issue". Derived only from
// facts every attempt can recompute (repository, commit, build event, task), so a restarted
// agent or runtime gets the same identity and never invents a new logical task. Non-secret:
// it is written into the issue body as a marker.
import { createHash } from "node:crypto";

export const ACTION_ID = "github.issues.create_ci_failure";
export const TASK_NAME = "file-ci-failure-issue";

export interface WorkflowFacts {
  /** Repository under test, e.g. "vap-demo/sample-project". */
  repository: string;
  commit: string;
  /** Build event identity, e.g. a Cloud Build id (plus a run label in benchmarks). */
  buildEvent: string;
  task?: string;
}

export function deriveWorkflowId(f: WorkflowFacts): string {
  const h = createHash("sha256").update(JSON.stringify(["vap-ci-failure/v1", f.repository, f.commit, f.buildEvent, f.task ?? TASK_NAME])).digest("hex");
  return `vapwf-${h.slice(0, 24)}`;
}

/** VAP request key for the issue-creation operation of one workflow. */
export function requestKeyFor(workflowId: string): string {
  return `ci-issue:${workflowId}`;
}
