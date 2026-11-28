"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { redirectPathFromError } from "@/lib/errors";

/**
 * Returns a stable error handler that properly redirects on
 * `NEXT_REDIRECT` errors from server actions.
 *
 * In React, `throw err` inside a `useEffect` async callback becomes an
 * unhandled promise rejection — the framework never sees it. This hook detects
 * redirect errors and uses the Next.js router to navigate to the destination
 * the server chose. It must never substitute `/login`: a package restriction,
 * a role denial or a branch denial is not an expired session.
 *
 * Usage:
 *   const handleRedirect = useRedirectHandler();
 *   // inside a catch block:
 *   if (handleRedirect(err, setError, "Failed to load data")) return;
 */
export function useRedirectHandler() {
  const router = useRouter();

  return useCallback(
    function handleRedirect(
      err: unknown,
      setError: (msg: string) => void,
      fallbackMessage: string
    ): boolean {
      const target = redirectPathFromError(err);
      if (target) {
        router.replace(target);
        return true;
      }
      setError(fallbackMessage);
      return false;
    },
    [router]
  );
}
