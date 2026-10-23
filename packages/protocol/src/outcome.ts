import type { ExecutionStatus, Outcome, RetryDisposition, VerificationStatus } from "./enums.js";
import { UNRESOLVED_EXECUTION_STATUSES } from "./enums.js";
import type { Effect } from "./types.js";

/**
 * Derives the display outcome from the two independent status dimensions.
 *
 *   execution_status   verification_status            outcome
 *   queued             (any)                          requested
 *   running            (any)                          submitted
 *   unknown            (any)                          unknown
 *   failed             (any)                          failed
 *   cancelled          (any)                          cancelled
 *   partial            (any)                          partially_applied
 *   completed          passed                         verified
 *   completed          failed                         verification_failed
 *   completed          not_requested|pending|inconclusive  completed_unverified
 *
 * A completed execution is never shown as verified unless every bound check passed.
 */
export function deriveOutcome(execution: ExecutionStatus, verification: VerificationStatus): Outcome {
  switch (execution) {
    case "queued":
      return "requested";
    case "running":
      return "submitted";
    case "unknown":
      return "unknown";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "partial":
      return "partially_applied";
    case "completed":
      if (verification === "passed") return "verified";
      if (verification === "failed") return "verification_failed";
      return "completed_unverified";
  }
}

export function isUnresolved(execution: ExecutionStatus): boolean {
  return UNRESOLVED_EXECUTION_STATUSES.includes(execution);
}

export interface RetryGuidance {
  disposition: RetryDisposition;
  explanation: string;
}

/** Whether, and how, a caller may retry, given only what VAP has established. */
export function retryGuidance(execution: ExecutionStatus, verification: VerificationStatus, effects: Effect[]): RetryGuidance {
  const anyApplied = effects.some((e) => e.status === "applied");
  const anyUnknown = effects.some((e) => e.status === "unknown");
  switch (execution) {
    case "queued":
      return { disposition: "retry_with_same_key", explanation: "Accepted but not yet submitted. Resending the same request key returns this operation; do not prepare a duplicate." };
    case "running":
      return { disposition: "do_not_retry", explanation: "Submission may have occurred. Poll the operation or request cancellation; a new submission could duplicate effects." };
    case "unknown":
      return { disposition: "reconcile_first", explanation: "Effects cannot be established. Reconcile before any retry; if reconciliation cannot resolve it, an operator must." };
    case "failed":
      if (anyUnknown) return { disposition: "reconcile_first", explanation: "Execution failed but some effects are unknown. Reconcile before retrying." };
      if (anyApplied) return { disposition: "do_not_retry", explanation: "Execution failed after applying some effects. Use a declared recovery strategy or prepare a plan for the remaining work." };
      return { disposition: "safe_to_retry", explanation: "Execution failed with no effects applied. Correct the cause, prepare a new plan and submit with a new request key." };
    case "cancelled":
      if (anyApplied || anyUnknown) return { disposition: "do_not_retry", explanation: "Cancelled after some effects occurred or could not be ruled out. Cancellation is not rollback." };
      return { disposition: "safe_to_retry", explanation: "Cancelled before any effect. A new plan and request key may be submitted." };
    case "partial":
      return { disposition: "do_not_retry", explanation: "A known subset of effects occurred. Recover the identified effects or prepare a plan for the remaining items only." };
    case "completed":
      if (verification === "passed") return { disposition: "do_not_retry", explanation: "Completed and every bound check passed." };
      if (verification === "failed") return { disposition: "do_not_retry", explanation: "Execution completed but verification failed. Inspect evidence; recover or prepare a corrective plan rather than repeating." };
      return { disposition: "do_not_retry", explanation: "Execution completed; verification has not passed yet. Re-run verification rather than re-executing." };
  }
}
