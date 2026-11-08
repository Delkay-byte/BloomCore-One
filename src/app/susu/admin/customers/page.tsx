"use client";
import { SkeletonPage } from "@/components/ui/Skeletons";
import { useFormDraft } from "@/hooks/useFormDraft";
import DraftIndicator from "@/components/DraftIndicator";

import { CheckCircle2, Copy, Printer, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import {
  getCustomers,
  createCustomer,
  toggleCustomerStatus,
} from "@/lib/actions/susu-customer.actions";
import { getCollectors, assignCustomerToCollector } from "@/lib/actions/susu-collector.actions";
import { formatDate } from "@/lib/utils";
import CediAmount from "@/components/CediAmount";
import PasswordInput from "@/components/PasswordInput";
import Link from "next/link";

interface Customer {
  id: string;
  customerId: string;
  fullName: string;
  phone?: string | null;
  address?: string | null;
  status: string;
  registeredAt: Date;
  accounts: Array<{
    id: string;
    accountId: string;
    dailyContribution: number;
    cycles: Array<{ id: string; cycleNumber: number; status: string }>;
  }>;
  assignments: Array<{
    id: string;
    collector: { user: { fullName: string } };
  }>;
}

interface Collector {
  id: string;
  user: { fullName: string };
}

interface CreatedCustomerSummary {
  fullName: string;
  accountNumber: string;
  phone: string;
  dailyContribution: number;
  status: string;
  collectorName: string | null;
  portalEnabled: boolean;
}

export default function SusuCustomersPage() {
  const handleRedirect = useRedirectHandler();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [collectors, setCollectors] = useState<Collector[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const createFormRef = useRef<HTMLFormElement>(null);
  const createDraft = useFormDraft(createFormRef, {
    draftKey: "susu-customer:new",
    workflow: "susu.customer.create",
    enabled: showForm,
  });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [submitting, setSubmitting] = useState(false);
  const [enablePortal, setEnablePortal] = useState(false);
  const [portalPassword, setPortalPassword] = useState("");
  const [createdCustomer, setCreatedCustomer] =
    useState<CreatedCustomerSummary | null>(null);
  const [statusBusyId, setStatusBusyId] = useState<string | null>(null);
  const toast = useToast();

  // Assignment modal state
  const [assignModal, setAssignModal] = useState<{ open: boolean; customerId: string; accountId: string }>({
    open: false,
    customerId: "",
    accountId: "",
  });

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const [customerData, collectorData] = await Promise.all([
        getCustomers({ limit: 100 }),
        getCollectors(),
      ]);
      setCustomers(customerData.customers as unknown as Customer[]);
      setCollectors(collectorData as unknown as Collector[]);
    } catch (err) {
      if (handleRedirect(err, setError, "Failed to load data")) return;
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(formData: FormData) {
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      const result = await createCustomer(formData);
      if (result.success) {
        const data = result.data as
          | {
              customer?: {
                fullName?: string;
                customerId?: string;
                phone?: string | null;
                status?: string;
              };
              susuAccount?: { dailyContribution?: number };
              accountNumber?: string;
              portalEnabled?: boolean;
            }
          | undefined;
        const accountNumber =
          data?.accountNumber ?? data?.customer?.customerId ?? "";
        setCreatedCustomer({
          fullName: data?.customer?.fullName ?? "Customer",
          accountNumber,
          phone: data?.customer?.phone ?? "Not provided",
          dailyContribution: Number(data?.susuAccount?.dailyContribution ?? 0),
          status: data?.customer?.status ?? "active",
          collectorName: null,
          portalEnabled: Boolean(data?.portalEnabled),
        });
        // The success card is the confirmation. No duplicate banner or toast.
        setSuccess("");
        setShowForm(false);
        setEnablePortal(false);
        setPortalPassword("");
        await createDraft.clearDraft();
        loadData();
      } else {
        setError(result.error || "The customer account could not be created.");
        toast.push("error", result.error || "The customer account could not be created.");
      }
    } catch (err) {
      if (handleRedirect(err, setError, "An unexpected error occurred")) return;
      setError("The customer account could not be created. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function copyText(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.push("success", `${label} copied.`);
    } catch {
      toast.push("error", `We couldn't copy the ${label.toLowerCase()}. Please select it and copy manually.`);
    }
  }

  function copyAccountDetails() {
    if (!createdCustomer) return;
    const details = [
      "MaaCash Susu Account",
      `Customer: ${createdCustomer.fullName}`,
      `Account Number: ${createdCustomer.accountNumber}`,
      `Phone: ${createdCustomer.phone}`,
      `Daily Contribution: GH₵${createdCustomer.dailyContribution.toFixed(2)}`,
      `Status: ${createdCustomer.status}`,
    ].join("\n");
    void copyText(details, "Account details");
  }

  function printAccountSummary() {
    if (!createdCustomer) return;
    const escape = (value: string) =>
      value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const win = window.open("", "_blank", "width=640,height=720");
    if (!win) {
      toast.push("error", "The print window was blocked. Allow pop-ups and try again.");
      return;
    }
    win.document.write(`<!doctype html><html><head><title>Account Summary</title>
      <style>
        body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:32px;color:#0f172a}
        h1{font-size:20px;margin:0 0 4px}
        .muted{color:#64748b;font-size:13px}
        .account{margin:24px 0;padding:20px;border:2px solid #047857;border-radius:12px}
        .label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#64748b}
        .number{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:28px;font-weight:700;color:#065f46;margin-top:4px}
        table{width:100%;border-collapse:collapse;margin-top:16px}
        td{padding:8px 0;border-bottom:1px solid #e2e8f0;font-size:14px}
        td:last-child{text-align:right;font-weight:600}
      </style></head><body>
      <h1>MaaCash Susu Account</h1>
      <p class="muted">Customer Account Created Successfully</p>
      <div class="account">
        <div class="label">Account Number</div>
        <div class="number">${escape(createdCustomer.accountNumber)}</div>
      </div>
      <table>
        <tr><td>Customer Full Name</td><td>${escape(createdCustomer.fullName)}</td></tr>
        <tr><td>Phone Number</td><td>${escape(createdCustomer.phone)}</td></tr>
        <tr><td>Daily Contribution</td><td>GH₵${createdCustomer.dailyContribution.toFixed(2)}</td></tr>
        <tr><td>Assigned Collector</td><td>${escape(createdCustomer.collectorName ?? "Not assigned")}</td></tr>
        <tr><td>Account Status</td><td>${escape(createdCustomer.status)}</td></tr>
      </table>
      <p class="muted" style="margin-top:28px">Keep this Account Number safe. Use it with your phone number to sign in to the customer portal.</p>
      </body></html>`);
    win.document.close();
    win.focus();
    win.print();
  }

  async function handleToggleStatus(customer: Customer, newStatus: string) {
    if (statusBusyId) return;
    setStatusBusyId(customer.id);
    setError("");
    try {
      const result = await toggleCustomerStatus(customer.id, newStatus);
      if (result.success) {
        toast.push(
          "success",
          newStatus === "active"
            ? "Customer account activated."
            : "Customer account deactivated."
        );
        await loadData();
      } else {
        setError(result.error || "The customer status could not be updated.");
        toast.push("error", result.error || "The customer status could not be updated.");
      }
    } catch (err) {
      if (handleRedirect(err, setError, "An unexpected error occurred")) return;
      setError("The customer status could not be updated. Please try again.");
    } finally {
      setStatusBusyId(null);
    }
  }

  async function handleAssign(collectorId: string) {
    try {
      const result = await assignCustomerToCollector({
        collectorId,
        customerId: assignModal.customerId,
        accountId: assignModal.accountId,
      });
      if (result.success) {
        setSuccess("Customer assigned to collector");
        setAssignModal({ open: false, customerId: "", accountId: "" });
        loadData();
      } else {
        setError(result.error || "Failed to assign");
      }
    } catch (err) { if (handleRedirect(err, setError, "An unexpected error occurred")) return;
    }
  }

  const filtered = customers.filter((c) => {
    if (statusFilter !== "all" && c.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        c.fullName.toLowerCase().includes(q) ||
        c.customerId.toLowerCase().includes(q) ||
        (c.phone && c.phone.includes(q))
      );
    }
    return true;
  });

  if (loading) return <SkeletonPage variant="table" />;

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Susu Customers</h1>
          <p className="text-slate-500 mt-1">Manage Susu customers and their accounts</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="btn btn-primary">
          {showForm ? "Cancel" : "+ New Customer"}
        </button>
      </div>

      {error && (
        <div role="alert" className="banner banner-error mb-4">
          {error}
          <button onClick={() => setError("")} className="ml-2 text-red-500 hover:text-red-700">
            ✕
          </button>
        </div>
      )}
      {success && (
        <div role="status" className="banner banner-success mb-4">
          {success}
          <button onClick={() => setSuccess("")} className="ml-2 text-green-500 hover:text-green-700">
            ✕
          </button>
        </div>
      )}

      {createdCustomer && (
        <section
          className="mb-6 overflow-hidden rounded-2xl border border-emerald-200 bg-white shadow-[var(--shadow-card)]"
          aria-labelledby="created-customer-title"
        >
          <div className="flex items-start gap-3 bg-emerald-50 px-5 py-4">
            <div className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-emerald-600 text-white">
              <CheckCircle2 size={22} aria-hidden />
            </div>
            <div>
              <h2 id="created-customer-title" className="text-lg font-bold text-emerald-950">
                Customer Account Created Successfully
              </h2>
              <p className="text-sm text-emerald-800">
                Give the customer their Account Number. They can sign in with it or their
                registered phone number.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCreatedCustomer(null)}
              className="ml-auto rounded-md p-1 text-emerald-700 hover:bg-emerald-100"
              aria-label="Dismiss created customer summary"
            >
              ✕
            </button>
          </div>
          <div className="grid gap-5 p-5 md:grid-cols-[minmax(0,1fr)_240px] md:items-center">
            <div>
              <div className="rounded-xl border-2 border-emerald-600 bg-emerald-50/60 px-4 py-3">
                <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-emerald-700">
                  Account Number
                </p>
                <p className="mt-1 font-mono text-2xl font-bold tracking-wide text-emerald-950 sm:text-3xl">
                  {createdCustomer.accountNumber}
                </p>
              </div>
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-slate-500">Customer Full Name</dt>
                  <dd className="font-semibold text-slate-900">{createdCustomer.fullName}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Phone Number</dt>
                  <dd className="font-medium text-slate-900">{createdCustomer.phone}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Daily Contribution</dt>
                  <dd className="font-medium text-slate-900">
                    <CediAmount amount={createdCustomer.dailyContribution} />/day
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Assigned Collector</dt>
                  <dd className="font-medium text-slate-900">
                    {createdCustomer.collectorName ?? "Not assigned"}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Account Status</dt>
                  <dd>
                    <span className="badge badge-green">{createdCustomer.status}</span>
                  </dd>
                </div>
              </dl>
              {createdCustomer.portalEnabled && (
                <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  Portal access is enabled. Share the temporary password privately. It is
                  never displayed here.
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => copyText(createdCustomer.accountNumber, "Account Number")}
                className="btn btn-primary w-full"
              >
                <Copy size={15} aria-hidden /> Copy Account Number
              </button>
              <button type="button" onClick={copyAccountDetails} className="btn btn-secondary w-full">
                <Copy size={15} aria-hidden /> Copy Account Details
              </button>
              <button type="button" onClick={printAccountSummary} className="btn btn-secondary w-full">
                <Printer size={15} aria-hidden /> Print Account Summary
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Create Form */}
      {showForm && (
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-4">Register New Customer</h2>
          <form ref={createFormRef} action={handleCreate}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="form-group">
                <label className="form-label">Full Name *</label>
                <input type="text" name="fullName" autoComplete="name" placeholder="Enter customer name" required />
              </div>
              <div className="form-group">
                <label className="form-label">Phone</label>
                <input type="tel" name="phone" autoComplete="tel" placeholder="+233 XX XXX XXXX" />
              </div>
              <div className="form-group">
                <label className="form-label">Address</label>
                <input type="text" name="address" autoComplete="street-address" placeholder="Customer address" />
              </div>
              <div className="form-group">
                <label className="form-label">Daily Contribution (GH₵) *</label>
                <input
                  type="number"
                  name="dailyContribution"
                  autoComplete="off"
                  step="0.01"
                  min="0.01"
                  placeholder="e.g. 50"
                  required
                />
                <p className="form-hint">The amount the customer commits to save per day</p>
              </div>
              <div className="form-group">
                <label className="form-label">Card Fee (GH₵)</label>
                <input
                  type="number"
                  name="cardFee"
                  step="0.01"
                  min="0"
                  defaultValue={10}
                  placeholder="10"
                />
                <p className="form-hint">Standard card fee is GH₵10</p>
              </div>
            </div>

            {/* Optional: enable portal access with a temporary password at creation */}
            <div className="form-group md:col-span-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  name="enablePortal"
                  checked={enablePortal}
                  onChange={(e) => setEnablePortal(e.target.checked)}
                />
                <span className="text-sm font-medium text-slate-700">
                  Enable Customer Portal &amp; set a temporary password
                </span>
              </label>
              <p className="form-hint">
                Optional. The customer can sign in immediately and must change the password on first login.
              </p>
            </div>

            {enablePortal && (
              <div className="form-group md:col-span-2">
                <label className="form-label">Temporary Password</label>
                <PasswordInput
                  name="temporaryPassword"
                  value={portalPassword}
                  onChange={(e) => setPortalPassword(e.target.value)}
                  placeholder="Min 8 characters"
                  required
                />
                <p className="form-hint">Give this password to the customer privately.</p>
              </div>
            )}

            <div className="mb-3">
              <DraftIndicator
                status={createDraft.status}
                lastSavedAt={createDraft.lastSavedAt}
                onDiscard={createDraft.clearDraft}
                onAcknowledge={createDraft.acknowledgeRestored}
                onRetry={createDraft.retry}
              />
            </div>
            <div className="flex gap-3 mt-4">
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? "Creating..." : "Create Customer"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setShowForm(false);
                  setEnablePortal(false);
                  setPortalPassword("");
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Filters */}
      <div className="card mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="form-group">
            <label className="form-label">Search</label>
            <input
              type="text"
              placeholder="Name, Account Number, or phone..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="all">All Statuses</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        </div>
      </div>

      {/* Customer List */}
      <div className="card">
        {filtered.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <p className="text-4xl mb-2 [&>svg]:h-9 [&>svg]:w-9 flex justify-center text-brand-300" aria-hidden><UserRound size={36} /></p>
            <p className="font-medium">No customers found</p>
            <p className="text-sm mt-1">
              {search ? "Try adjusting your search." : "Register your first customer to get started."}
            </p>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Account Number</th>
                  <th>Daily Contribution</th>
                  <th>Cycle</th>
                  <th>Collector</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((customer) => {
                  const account = customer.accounts[0];
                  const cycle = account?.cycles[0];
                  const collector = customer.assignments[0]?.collector?.user?.fullName;
                  return (
                    <tr key={customer.id}>
                      <td>
                        <div className="font-medium">{customer.fullName}</div>
                        {customer.phone && (
                          <div className="text-xs text-slate-400">{customer.phone}</div>
                        )}
                      </td>
                      <td className="font-mono text-sm font-semibold">
                        {customer.customerId}
                      </td>
                      <td className="font-mono text-sm">
                        {account ? <><CediAmount amount={account.dailyContribution} />/day</> : "—"}
                      </td>
                      <td>
                        {cycle ? (
                          <span className="badge badge-blue">Cycle {cycle.cycleNumber}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        {collector ? (
                          <span className="text-sm">{collector}</span>
                        ) : (
                          <button
                            onClick={() =>
                              setAssignModal({
                                open: true,
                                customerId: customer.id,
                                accountId: account?.id || "",
                              })
                            }
                            className="text-sm text-blue-600 hover:text-blue-800"
                          >
                            Assign
                          </button>
                        )}
                      </td>
                      <td>
                        <span
                          className={`badge ${
                            customer.status === "active" ? "badge-green" : "badge-red"
                          }`}
                        >
                          {customer.status}
                        </span>
                      </td>
                      <td>
                        <div className="flex gap-2">
                          <Link
                            href={`/susu/admin/customers/${customer.id}`}
                            className="text-sm text-blue-600 hover:text-blue-800"
                          >
                            View
                          </Link>
                          <button
                            onClick={() =>
                              handleToggleStatus(
                                customer,
                                customer.status === "active" ? "inactive" : "active"
                              )
                            }
                            disabled={statusBusyId === customer.id}
                            className={`text-sm disabled:opacity-60 ${
                              customer.status === "active"
                                ? "text-red-600 hover:text-red-800"
                                : "text-green-600 hover:text-green-800"
                            }`}
                          >
                            {statusBusyId === customer.id
                              ? "Updating…"
                              : customer.status === "active"
                                ? "Deactivate"
                                : "Activate"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Assignment Modal */}
      {assignModal.open && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold mb-4">Assign Collector</h3>
            <p className="text-sm text-slate-500 mb-4">Select a collector for this customer:</p>
            <div className="space-y-2">
              {collectors.map((c) => (
                <button
                  key={c.id}
                  onClick={() => handleAssign(c.id)}
                  className="w-full text-left p-3 rounded-lg border border-slate-200 hover:bg-green-50 hover:border-green-300 transition-colors"
                >
                  {c.user.fullName}
                </button>
              ))}
            </div>
            <button
              onClick={() => setAssignModal({ open: false, customerId: "", accountId: "" })}
              className="btn btn-secondary w-full mt-4"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
