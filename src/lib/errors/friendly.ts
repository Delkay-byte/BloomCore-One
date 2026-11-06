/**
 * Friendly, centralized user-facing error messages.
 *
 * The UI never renders a raw exception, SQL message, stack trace or framework
 * error. Server actions may return a curated message; HTTP responses are mapped
 * here by status. Anything else becomes a short, actionable sentence.
 */

export type AppErrorCode =
  | "offline"
  | "network"
  | "timeout"
  | "session_expired"
  | "permission_denied"
  | "validation"
  | "duplicate"
  | "conflict"
  | "not_found"
  | "rate_limited"
  | "sync_failed"
  | "storage_full"
  | "storage_unavailable"
  | "server_unavailable"
  | "internal"
  | "unknown";

export interface UserFacingError {
  code: AppErrorCode;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
}

const MESSAGES: Record<AppErrorCode, Omit<UserFacingError, "code">> = {
  offline: {
    message: "You're offline. Check your connection and try again.",
    retryable: true,
  },
  network: {
    message: "We couldn't reach MaaCash. Please try again.",
    retryable: true,
  },
  timeout: {
    message: "This is taking longer than expected. Please try again.",
    retryable: true,
  },
  session_expired: {
    message: "Your session has expired. Please sign in again.",
    retryable: false,
  },
  permission_denied: {
    message: "You don't have permission to perform this action.",
    retryable: false,
  },
  validation: {
    message: "Please check the highlighted fields.",
    retryable: false,
  },
  duplicate: {
    message: "This transaction has already been submitted.",
    retryable: false,
  },
  conflict: {
    message: "This record has changed. Refresh it before making another update.",
    retryable: true,
  },
  not_found: {
    message: "We couldn't find that record. It may have been moved or removed.",
    retryable: false,
  },
  rate_limited: {
    message: "Too many attempts. Please wait a moment and try again.",
    retryable: true,
  },
  sync_failed: {
    message: "Some records are still waiting to synchronize.",
    retryable: true,
  },
  storage_full: {
    message:
      "This device has run out of storage for offline records. Sync or remove old records, then try again.",
    retryable: true,
  },
  storage_unavailable: {
    message:
      "This device cannot save offline records right now. Keep this page open and try again when storage is available.",
    retryable: true,
  },
  server_unavailable: {
    message: "The service is temporarily unavailable. Please try again shortly.",
    retryable: true,
  },
  internal: {
    message: "Something went wrong. Please try again.",
    retryable: true,
  },
  unknown: {
    message: "Something went wrong. Please try again.",
    retryable: true,
  },
};

export function messageForCode(code: AppErrorCode): UserFacingError {
  return { code, ...MESSAGES[code] };
}

const CODE_BY_STATUS: Record<number, AppErrorCode> = {
  400: "validation",
  401: "session_expired",
  403: "permission_denied",
  404: "not_found",
  409: "duplicate",
  422: "validation",
  429: "rate_limited",
  502: "server_unavailable",
  503: "server_unavailable",
  504: "timeout",
};

/** Return true when a string looks like an internal implementation detail. */
function looksInternal(value: string): boolean {
  return /(sql|prisma|stack|trace|exception|ECONN|ENOTFOUND|at\s+\w+\s*\(|node_modules|\/src\/|P\d{4}|duplicate key|unique constraint|violates|relation .* does not exist|column .* does not exist)/i.test(
    value
  );
}

/**
 * A curated server message is shown only when it is short, printable and does
 * not expose internal details. Everything else falls back to the mapped text.
 */
export function safeServerMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 220) return null;
  if (looksInternal(trimmed)) return null;
  return trimmed;
}

function codeForStatus(status: number): AppErrorCode {
  if (CODE_BY_STATUS[status]) return CODE_BY_STATUS[status];
  if (status >= 500) return "internal";
  return "unknown";
}

/**
 * Build a user-facing error from an HTTP status and optional server payload.
 * `retryAfterSeconds` may come from a `Retry-After` header.
 */
export function fromHttpStatus(
  status: number,
  serverMessage?: unknown,
  retryAfterSeconds?: number
): UserFacingError {
  const code = codeForStatus(status);
  const base = messageForCode(code);
  const curated = status < 500 ? safeServerMessage(serverMessage) : null;

  return {
    ...base,
    message: curated ?? base.message,
    retryable: code === "rate_limited" ? true : base.retryable,
    retryAfterSeconds:
      code === "rate_limited"
        ? Math.max(1, retryAfterSeconds ?? 60)
        : undefined,
  };
}

/** Normalize any thrown value, fetch failure or storage error. */
export function toUserMessage(error: unknown): UserFacingError {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return messageForCode("offline");
  }

  if (error instanceof DOMException) {
    if (error.name === "QuotaExceededError") return messageForCode("storage_full");
    if (error.name === "AbortError") return messageForCode("timeout");
    if (error.name === "InvalidStateError" || error.name === "NotFoundError") {
      return messageForCode("storage_unavailable");
    }
  }

  if (error instanceof Error) {
    if (error.name === "AbortError") return messageForCode("timeout");
    if (error.name === "TimeoutError") return messageForCode("timeout");
    if (/quota|storage/i.test(error.name) || /quota/i.test(error.message)) {
      return messageForCode("storage_full");
    }
    if (/failed to fetch|networkerror|network request failed/i.test(error.message)) {
      return messageForCode("network");
    }
    // Server actions already return curated text; a thrown Error with a short
    // sentence is usually intentional. Internal-looking text is discarded.
    const curated = safeServerMessage(error.message);
    if (curated && !/^[A-Z_]+$/.test(curated)) {
      return { ...messageForCode("internal"), message: curated };
    }
  }

  return messageForCode("unknown");
}

/** Error thrown by offline storage helpers so callers can react precisely. */
export class OfflineStorageError extends Error {
  constructor(
    public code: "storage_full" | "storage_unavailable" | "write_failed",
    message?: string
  ) {
    super(message ?? MESSAGES[code === "write_failed" ? "storage_unavailable" : code].message);
    this.name = "OfflineStorageError";
  }
}

/** Stable user-facing text for a sync result returned by the sync manager. */
export function syncFailureMessage(error?: string): string {
  const curated = safeServerMessage(error);
  return curated ?? MESSAGES.sync_failed.message;
}
