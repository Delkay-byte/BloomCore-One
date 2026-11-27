"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Notice from "@/components/ui/Notice";
import { createSupportRequest } from "@/lib/actions/susu-support.actions";

interface Option {
  value: string;
  label: string;
}

export default function SupportRequestForm({
  categories,
  priorities,
  branches,
}: {
  categories: Option[];
  priorities: Option[];
  branches: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [category, setCategory] = useState(categories[0]?.value ?? "general");
  const [priority, setPriority] = useState("normal");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [branchId, setBranchId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await createSupportRequest({
        category,
        priority,
        subject,
        description,
        branchId: branchId || null,
      });
      if (!result.success) {
        setError(result.error || "The request could not be opened.");
        return;
      }
      setSubject("");
      setDescription("");
      router.push("/susu/support/" + result.requestId);
    } catch {
      setError("The request could not be opened. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-4">
      <div>
        <h2 className="text-base font-semibold text-brand-900">Open a support request</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Tell us what is blocking you. Never include passwords, PINs, API keys or customer
          account numbers; support will ask through a secure channel if it needs more detail.
        </p>
      </div>
      {error && <Notice type="error" message={error}>{error}</Notice>}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-ink">What is it about?</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)} className="w-full">
            {categories.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-ink">How urgent is it?</span>
          <select value={priority} onChange={(event) => setPriority(event.target.value)} className="w-full">
            {priorities.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {branches.length > 0 && (
          <label className="block text-sm sm:col-span-2">
            <span className="mb-1 block font-medium text-ink">Branch (optional)</span>
            <select value={branchId} onChange={(event) => setBranchId(event.target.value)} className="w-full">
              <option value="">Company-wide</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-ink">Subject</span>
        <input
          type="text"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          maxLength={140}
          required
          placeholder="Short summary, for example: Daily closing totals do not match"
          className="w-full"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-ink">What happened?</span>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={4000}
          rows={5}
          required
          placeholder="What you did, what you expected, what you saw. Include the reference of any affected transaction."
          className="w-full"
        />
      </label>
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? "Opening…" : "Open request"}
      </button>
    </form>
  );
}