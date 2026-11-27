"use server";

import { createBranch, createBranchManager, toggleBranchStatus } from "./branch.actions";

/** Form-action adapters: React form actions must return void. */
export async function createBranchForm(formData: FormData): Promise<void> {
  await createBranch(formData);
}

export async function createBranchManagerForm(formData: FormData): Promise<void> {
  await createBranchManager(formData);
}

export async function toggleBranchForm(
  branchId: string,
  status: "active" | "inactive",
  _formData: FormData
): Promise<void> {
  await toggleBranchStatus(branchId, status);
}
