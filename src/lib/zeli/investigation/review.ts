/**
 * Human review of an AI draft.
 *
 * A draft has no effect until a person accepts it, and even then it does not change
 * the finding: accepting records a decision about the explanation, not about the
 * money. This is the rule the audit asked for (S.15) and the one that is easy to
 * break later, so it lives in a pure function with tests.
 */

export const DRAFT_STATUSES = ["draft", "reviewed", "accepted", "rejected"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const DRAFT_STATUS_LABELS: Record<DraftStatus, string> = {
  draft: "Waiting for review",
  reviewed: "Reviewed, awaiting a decision",
  accepted: "Accepted by a reviewer",
  rejected: "Rejected by a reviewer",
};

export const REVIEW_DECISIONS = ["accept", "reject", "request_changes"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export interface ReviewTransition {
  allowed: boolean;
  nextStatus?: DraftStatus;
  requiresReason: boolean;
  error?: string;
  /** Accepting an explanation never closes the finding. */
  affectsFinding: false;
}

export function decideReview(input: {
  status: DraftStatus;
  decision: ReviewDecision;
  reason: string;
  reviewerIsAuthor: boolean;
}): ReviewTransition {
  const reason = input.reason.trim();

  if (input.status === "accepted" || input.status === "rejected") {
    return {
      allowed: false,
      requiresReason: true,
      affectsFinding: false,
      error: "This draft has already been decided. Generate a new one instead.",
    };
  }
  if (input.decision === "reject" && reason.length < 5) {
    return {
      allowed: false,
      requiresReason: true,
      affectsFinding: false,
      error: "Say why the draft is rejected.",
    };
  }
  if (input.decision === "request_changes" && reason.length < 5) {
    return {
      allowed: false,
      requiresReason: true,
      affectsFinding: false,
      error: "Say what needs to change.",
    };
  }
  if (input.decision === "accept" && reason.length < 5) {
    return {
      allowed: false,
      requiresReason: true,
      affectsFinding: false,
      error: "Record what you checked before accepting this explanation.",
    };
  }
  if (input.reviewerIsAuthor) {
    return {
      allowed: false,
      requiresReason: true,
      affectsFinding: false,
      error: "A draft must be reviewed by someone other than the person who generated it.",
    };
  }

  return {
    allowed: true,
    nextStatus:
      input.decision === "accept"
        ? "accepted"
        : input.decision === "reject"
          ? "rejected"
          : "reviewed",
    requiresReason: true,
    affectsFinding: false,
  };
}
