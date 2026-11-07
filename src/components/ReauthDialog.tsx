"use client";

import { useState } from "react";
import { verifyPasswordAction } from "@/lib/actions/auth.actions";
import PasswordInput from "@/components/PasswordInput";
import type { ModuleName } from "@/lib/auth";

/**
 * Step-up reauthentication dialog.
 *
 * Used before high-impact operations:
 * - Admin password reset for another user
 * - Susu withdrawal processing
 * - Critical capability changes
 *
 * The server verifies the password.  It is never logged or stored in state
 * outside this component.
 */
export default function ReauthDialog({
  open,
  onClose,
  onConfirmed,
  title = "Confirm your identity",
  description = "For your security, enter your password before continuing.",
  actionLabel = "Confirm",
  module,
}: {
  open: boolean;
  onClose: () => void;
  onConfirmed: () => void;
  title?: string;
  description?: string;
  actionLabel?: string;
  /** Session whose password must be confirmed. Admin screens pass "admin". */
  module?: ModuleName;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    if (password.length === 0) {
      setError("Password is required");
      return;
    }
    setLoading(true);
    setError("");

    try {
      // Compare exactly what was typed: sign-in does not trim either.
      const result = await verifyPasswordAction(
        password,
        module ? { module } : undefined
      );
      if (result.success) {
        setPassword("");
        onConfirmed();
      } else {
        setError(result.error || "Incorrect password");
      }
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  }

  function handleClose() {
    setPassword("");
    setError("");
    onClose();
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black bg-opacity-50 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reauth-title"
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <h2
          id="reauth-title"
          className="text-lg font-semibold text-gray-900"
        >
          {title}
        </h2>
        <p className="text-sm text-gray-600 mt-2">{description}</p>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm mt-4">
            {error}
          </div>
        )}

        <div className="mt-4">
          <label className="form-label" htmlFor="reauth-password">
            Password
          </label>
          <PasswordInput
            id="reauth-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleConfirm();
              }
            }}
            placeholder="Enter your password"
            autoComplete="current-password"
          />
        </div>

        <div className="flex gap-3 mt-6">
          <button
            type="button"
            onClick={handleClose}
            className="btn btn-secondary flex-1"
            disabled={loading}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="btn btn-primary flex-1"
            disabled={loading}
          >
            {loading ? "Verifying..." : actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
