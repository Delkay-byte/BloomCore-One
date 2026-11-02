"use client";
import { Banknote, X } from "lucide-react";
import { getContributions, recordContribution } from "@/lib/actions/susu-contribution.actions";
import { reverseContribution } from "@/lib/actions/financial-reversal.actions";
import { searchCustomers, searchStaff } from "@/lib/actions/susu-customer.actions";
import { getCollectors } from "@/lib/actions/susu-collector.actions";
import { formatCedi, formatDateTime } from "@/lib/utils";
import CediAmount from "@/components/CediAmount";
import { useEffect, useState } from "react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import SmartSearch from "@/components/SmartSearch";

interface Contribution {
  id: string;
  amount: number;
  reversedAt?: string | null;
  reversalOfId?: string | null;
  collectionDate: Date;
  channel: string;
  notes?: string | null;
  account: {
    accountId: string;
    customer: { customerId: string; fullName: string };
  };
  allocations: Array<{ cycleDay: number; amount: number }>;
  collector?: { user: { fullName: string } } | null;
  recordedBy?: { fullName: string } | null;
  recordedByName?: string | null;
  receivedBy?: { fullName: string } | null;
  receivedByName?: string | null;
}

interface CustomerSearchResult {
  id: string;
  customerId: string;
  fullName: string;
  accounts: Array<{
    id: string;
    accountId: string;
    dailyContribution: number;
    cycles: Array<{ id: string; status: string }>;
  }>;
}

interface CollectorOption {
  id: string;
  user: { fullName: string };
}

export default function SusuContributionsPage() {
  const handleRedirect = useRedirectHandler();
  const [contributions, setContributions] = useState<Contribution[]>([]);
  const [pagination, setPagination] = useState<{ page: number; totalPages: number; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [page, setPage] = useState(1);
  const [channelFilter, setChannelFilter] = useState("");

  // Recording form state
  const [showForm, setShowForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<CustomerSearchResult[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerSearchResult | null>(null);
  const [collectors, setCollectors] = useState<CollectorOption[]>([]);
  const [selectedCollector, setSelectedCollector] = useState("");
  const [amount, setAmount] = useState("");
  const [channel, setChannel] = useState<"collector" | "direct_office">("direct_office");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [currentUser, setCurrentUser] = useState<{ id: string; fullName: string } | null>(null);
  const [receivedById, setReceivedById] = useState("");
  const [receivedByName, setReceivedByName] = useState("");
  const [recordedById, setRecordedById] = useState("");
  const [recordedByName, setRecordedByName] = useState("");

  async function handleReverse(c: Contribution) {
    const reason = window.prompt(
      "Reason for reversing this contribution (minimum 10 characters). The original entry is kept and a negative reversal entry is posted."
    );
    if (!reason) return;
    const result = await reverseContribution({ contributionId: c.id, reason });
    if (!result.success) {
      setError(result.error || "Reversal failed");
      return;
    }
    setSuccess("Contribution reversed. The original entry and the reversal are both in the audit trail.");
    loadContributions();
  }

  // Load current user and prefill Recorded By with the authenticated staff.
  // The field remains changeable to another authorized staff member.
  useEffect(() => {
    async function loadCurrentUser() {
      try {
        const authRes = await fetch("/api/auth/me?module=admin");
        if (authRes.ok) {
          const authUser = await authRes.json();
          if (authUser?.userId) {
            const fullName = authUser.fullName || "Current User";
            setCurrentUser({ id: authUser.userId, fullName });
            // Preselect Recorded By with current user (changeable)
            setRecordedById(authUser.userId);
            setRecordedByName(fullName);
          }
        }
      } catch {
        /* ignore */
      }
    }
    loadCurrentUser();
  }, []);

  async function loadContributions() {
    setLoading(true);
    try {
      const result = await getContributions({
        page,
        limit: 15,
        channel: channelFilter || undefined,
      });
      setContributions(result.contributions as unknown as Contribution[]);
      setPagination(result.pagination);
    } catch (err) { if (handleRedirect(err, setError, "Failed to load contributions")) return;
    } finally {
      setLoading(false);
    }
  }

  async function loadCollectors() {
    try {
      const data = await getCollectors();
      setCollectors(data as unknown as CollectorOption[]);
    } catch (err) { if (handleRedirect(err, setError, "Failed to load collectors")) return;
    }
  }

  useEffect(() => {
    loadContributions();
  }, [page, channelFilter]);

  useEffect(() => {
    loadCollectors();
  }, []);

  async function handleSearch(query: string) {
    setSearchQuery(query);
    if (query.length < 2) {
      setSearchResults([]);
      return;
    }
    try {
      const results = await searchCustomers(query);
      setSearchResults(results as unknown as CustomerSearchResult[]);
    } catch (err) { if (handleRedirect(err, setError, "Search failed")) return;
    }
  }

  async function handleRecord() {
    if (!selectedCustomer) return;
    const account = selectedCustomer.accounts[0];
    if (!account) {
      setError("No active account found for this customer");
      return;
    }

    const amountNum = parseFloat(amount);
    if (!amountNum || amountNum <= 0) {
      setError("Please enter a valid amount");
      return;
    }

    if (channel === "direct_office" && !receivedById) {
      setError("Please select the staff who received this payment.");
      return;
    }

    if (channel === "direct_office" && !recordedById) {
      setError("Please select the staff member who recorded this payment.");
      return;
    }

    setSubmitting(true);
    setError("");
    setSuccess("");

    try {
      const result = await recordContribution({
        accountId: account.id,
        amount: amountNum,
        channel,
        collectorId: channel === "collector" ? selectedCollector : undefined,
        receivedById: channel === "direct_office" ? receivedById : undefined,
        receivedByName: channel === "direct_office" ? receivedByName : undefined,
        recordedById: channel === "direct_office" ? recordedById : undefined,
        recordedByName: channel === "direct_office" ? recordedByName : undefined,
        notes: notes || undefined,
      });

      if (result.success) {
        const collectorName = collectors.find((c) => c.id === selectedCollector)?.user?.fullName || "";
        const receivedByDisplay = channel === "direct_office" ? receivedByName : collectorName;
        setSuccess(
          channel === "direct_office"
            ? `${formatCedi(amountNum)} recorded.\nReceived by ${receivedByDisplay}.`
            : `${formatCedi(amountNum)} recorded.\nCollected by ${collectorName}.`
        );
        setShowForm(false);
        setSelectedCustomer(null);
        setSearchQuery("");
        setAmount("");
        setNotes("");
        setReceivedById("");
        setReceivedByName("");
        // Reset Recorded By to current user for next entry
        if (currentUser) {
          setRecordedById(currentUser.id);
          setRecordedByName(currentUser.fullName);
        } else {
          setRecordedById("");
          setRecordedByName("");
        }
        loadContributions();
      } else {
        setError(result.error || "Failed to record contribution");
      }
    } catch (err) { if (handleRedirect(err, setError, "An unexpected error occurred")) return;
      setError("An unexpected error occurred");
    } finally {
      setSubmitting(false);
    }
  }

  function handleExportCSV() {
    if (contributions.length === 0) return;
    const headers = [
      "Date",
      "Customer",
      "Customer ID",
      "Account ID",
      "Amount",
      "Days Covered",
      "Channel",
      "Received By",
      "Recorded By",
      "Notes",
    ];
    const rows = contributions.map((c) => [
      formatDateTime(c.collectionDate),
      c.account.customer.fullName,
      c.account.customer.customerId,
      c.account.accountId,
      String(c.amount),
      String(c.allocations.length),
      c.channel === "collector" ? "Collector" : "Office",
      c.channel === "collector"
        ? c.collector?.user?.fullName || "—"
        : c.receivedByName || c.receivedBy?.fullName || "—",
      c.recordedByName || c.recordedBy?.fullName || "Not recorded",
      c.notes || "",
    ]);
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${v}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bik-prestige-susu-contributions-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Contributions</h1>
          <p className="text-slate-500 mt-1">Record and view Susu contributions</p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleExportCSV} className="btn btn-secondary btn-sm" disabled={contributions.length === 0}>
            📥 Export CSV
          </button>
          <button
            onClick={() => {
              setShowForm(!showForm);
            }}
            className="btn btn-primary"
          >
            {showForm ? "Cancel" : "+ Record Contribution"}
          </button>
        </div>
      </div>

      {error && (
        <div className="banner banner-error mb-4">
          {error}
          <button onClick={() => setError("")} className="ml-2"><X size={14} aria-hidden /></button>
        </div>
      )}
      {success && (
        <div className="banner banner-success mb-4">
          {success}
          <button onClick={() => setSuccess("")} className="ml-2"><X size={14} aria-hidden /></button>
        </div>
      )}

      {/* Record Contribution Form */}
      {showForm && (
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-4">Record Contribution</h2>

          {/* Customer Search */}
          <div className="form-group">
            <label className="form-label">Search Customer *</label>
            <input
              type="text"
              placeholder="Search by name, ID, or phone..."
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
            />
            {searchResults.length > 0 && (
              <div className="border border-slate-200 rounded-lg mt-1 max-h-48 overflow-y-auto">
                {searchResults.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setSelectedCustomer(c);
                      setSearchQuery(c.fullName);
                      setSearchResults([]);
                    }}
                    className="w-full text-left p-3 hover:bg-slate-50 border-b border-slate-100 last:border-0"
                  >
                    <div className="font-medium text-sm">{c.fullName}</div>
                    <div className="text-xs text-slate-500">
                      {c.customerId} &bull; {c.accounts[0]?.accountId} &bull;{" "}
                      <CediAmount amount={c.accounts[0]?.dailyContribution || 0} />/day
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {selectedCustomer && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4">
              <div className="font-medium">{selectedCustomer.fullName}</div>
              <div className="text-sm text-slate-600">
                Account: {selectedCustomer.accounts[0]?.accountId} &bull; Daily:{" "}
                <CediAmount amount={selectedCustomer.accounts[0]?.dailyContribution || 0} />/day
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="form-group">
              <label className="form-label">Amount (GH₵) *</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                placeholder="Enter amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              {selectedCustomer && amount && (
                <p className="form-hint">
                  ≈ {Math.floor(parseFloat(amount) / (selectedCustomer.accounts[0]?.dailyContribution || 1))} day(s)
                  covered
                </p>
              )}
            </div>
            <div className="form-group">
              <label className="form-label">Channel *</label>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value as "collector" | "direct_office")}
              >
                <option value="direct_office">Direct Office</option>
                <option value="collector">Collector</option>
              </select>
            </div>
            {channel === "collector" && (
              <div className="form-group">
                <label className="form-label">Collector *</label>
                <select
                  value={selectedCollector}
                  onChange={(e) => setSelectedCollector(e.target.value)}
                >
                  <option value="">Select collector</option>
                  {collectors.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.user.fullName}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {channel === "direct_office" && (
              <>
                <div className="form-group">
                  <label className="form-label">Received By *</label>
                  <SmartSearch
                    label=""
                    placeholder="Search staff by name, email, or phone..."
                    searchFn={searchStaff}
                    onSelect={(option) => {
                      setReceivedById(option.id);
                      setReceivedByName(option.label);
                    }}
                    onClear={() => {
                      setReceivedById("");
                      setReceivedByName("");
                    }}
                    selectedOption={receivedById ? { id: receivedById, label: receivedByName } : null}
                    minQueryLength={2}
                    debounceMs={200}
                  />
                  <p className="form-hint text-xs mt-1">
                    The person who physically received the customer&apos;s money.
                  </p>
                </div>
                <div className="form-group">
                  <label className="form-label">Recorded By *</label>
                  <SmartSearch
                    label=""
                    placeholder="Search staff by name, email, or phone..."
                    searchFn={searchStaff}
                    onSelect={(option) => {
                      setRecordedById(option.id);
                      setRecordedByName(option.label);
                    }}
                    onClear={() => {
                      setRecordedById("");
                      setRecordedByName("");
                    }}
                    selectedOption={recordedById ? { id: recordedById, label: recordedByName } : null}
                    minQueryLength={2}
                    debounceMs={200}
                  />
                  <p className="form-hint text-xs mt-1">
                    The staff member who recorded this payment in the system.
                  </p>
                </div>
              </>
            )}
            <div className="form-group">
              <label className="form-label">Notes</label>
              <input
                type="text"
                placeholder="Optional note"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>
          <div className="flex gap-3 mt-4">
            <button
              onClick={handleRecord}
              className="btn btn-primary"
              disabled={submitting || !selectedCustomer}
            >
              {submitting ? "Recording..." : "Record Contribution"}
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setSelectedCustomer(null);
                // Reset Recorded By to current user for next entry
                if (currentUser) {
                  setRecordedById(currentUser.id);
                  setRecordedByName(currentUser.fullName);
                } else {
                  setRecordedById("");
                  setRecordedByName("");
                }
              }}
              className="btn btn-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="card mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="form-group">
            <label className="form-label">Channel</label>
            <select
              value={channelFilter}
              onChange={(e) => {
                setChannelFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All Channels</option>
              <option value="collector">Collector</option>
              <option value="direct_office">Direct Office</option>
            </select>
          </div>
        </div>
      </div>

      {/* Contributions List */}
      <div className="card">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="spinner"></div>
          </div>
        ) : contributions.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <p className="text-4xl mb-2 [&>svg]:h-9 [&>svg]:w-9 flex justify-center text-brand-300" aria-hidden><Banknote size={36} /></p>
            <p className="font-medium">No contributions found</p>
          </div>
        ) : (
          <>
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Customer</th>
                    <th>Amount</th>
                    <th>Days Covered</th>
                    <th>Channel</th>
                    <th>Received By</th>
                    <th>Recorded By</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {contributions.map((c) => (
                    <tr key={c.id}>
                      <td className="text-sm">{formatDateTime(c.collectionDate)}</td>
                      <td>
                        <div className="font-medium text-sm">{c.account.customer.fullName}</div>
                        <div className="text-xs text-slate-500">{c.account.customer.customerId}</div>
                      </td>
                      <td className="font-mono font-semibold"><CediAmount amount={c.amount} /></td>
                      <td>
                        <span className="badge badge-blue">{c.allocations.length} day(s)</span>
                      </td>
                      <td>
                        <span className={`badge ${c.channel === "collector" ? "badge-yellow" : "badge-green"}`}>
                          {c.channel === "collector" ? "Collector" : "Office"}
                        </span>
                      </td>
                      <td className="text-sm">
                        {c.channel === "collector"
                          ? c.collector?.user?.fullName || "—"
                          : c.receivedByName || c.receivedBy?.fullName || "Not recorded"}
                      </td>
                      <td className="text-sm">
                        {c.recordedByName || c.recordedBy?.fullName || "Not recorded"}
                      </td>
                      <td>
                        <span className={`badge ${c.reversedAt ? "badge-orange" : "badge-green"}`}>
                          {c.reversalOfId ? "reversal" : c.reversedAt ? "reversed" : "posted"}
                        </span>
                      </td>
                      <td>
                        {!c.reversedAt && !c.reversalOfId && (
                          <button
                            type="button"
                            className="text-xs text-red-600 hover:text-red-700 underline"
                            onClick={() => handleReverse(c)}
                          >
                            Reverse
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pagination && pagination.totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-200">
                <p className="text-sm text-slate-500">
                  Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="btn btn-secondary btn-sm"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
                    disabled={page === pagination.totalPages}
                    className="btn btn-secondary btn-sm"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
