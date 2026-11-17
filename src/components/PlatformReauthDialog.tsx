"use client";

import { useState } from "react";
import { verifyPlatformStepUpAction } from "@/lib/actions/platform.actions";
import PasswordInput from "@/components/PasswordInput";
import type { StepUpPurpose } from "@/lib/security/step-up";

/**
 * SEC-04 step-up dialog for platform-console operations. It verifies the
 * platform operator's own password and returns a single-use grant bound to
 * one purpose and target.
 */
export default function PlatformReauthDialog({
  open,
  onClose,
  onConfirmed,
  purpose,
  targetType,
  targetId,
  context,
  title = "Confirm your identity",
  description = "Enter your platform administrator password to continue.",
  actionLabel = "Confirm",
}: {
  open: boolean;
  onClose: () => void;
  onConfirmed: (stepUpToken: string) => void;
  purpose: StepUpPurpose;
  targetType?: string;
  targetId?: string;
  context?: Record<string, unknown>;
  title?: string;
  description?: string;
  actionLabel?: string;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    if (!password) {
      setError("Password is required");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await verifyPlatformStepUpAction(password, {
        purpose,
        targetType,
        targetId,
        context,
      });
      if (result.success) {
        setPassword("");
        const data = result.data as { stepUpToken?: string } | undefined;
        onConfirmed(data?.stepUpToken ?? "");
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
      aria-labelledby="platform-reauth-title"
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <h2 id="platform-reauth-title" className="text-lg font-semibold text-gray-900">
          {title}
        </h2>
        <p className="text-sm text-gray-600 mt-2">{description}</p>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm mt-4">
            {error}
          </div>
        )}
        <div className="mt-4">
          <label className="form-label" htmlFor="platform-reauth-password">
            Password
          </label>
          <PasswordInput
            id="platform-reauth-password"
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
