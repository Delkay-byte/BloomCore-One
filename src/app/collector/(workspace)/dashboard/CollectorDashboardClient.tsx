"use client";

import { UserPlus, Wallet, RefreshCw, Info, CheckCircle2, Clock } from "lucide-react";
import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import { getCollectorDashboardStats } from "@/lib/actions/susu-dashboard.actions";
import { recordContribution } from "@/lib/actions/susu-contribution.actions";
import { registerCustomerByCollector } from "@/lib/actions/susu-collector.actions";
import { formatCedi, getGreeting, getDailyQuote } from "@/lib/utils";
import {
  addTransaction,
  getCachedCustomers,
  getOfflineQueueSummary,
  getPendingTransactions,
  openTransactionPayload,
  cacheCustomers,
  type OfflineTransaction,
  type CachedCustomer,
} from "@/lib/offline/store";
import { getOrCreateDeviceId } from "@/lib/offline/device";
import { getCurrentOfflineContext, offlineContextExpired } from "@/lib/offline/device-store";
import { getOfflineScope, setOfflineScope } from "@/lib/offline/scope";
import {
  activateOfflineAccess,
  getOfflineReadiness,
  prepareOfflineAccess,
  reconcileOfflineConnectivity,
  type OfflineReadiness,
} from "@/lib/offline/preparation";
import { syncPendingTransactions, checkConnectivity, startAutoSync, stopAutoSync, hydrateOfflineAuthorization, isOfflineAuthExpired, secondsUntilOfflineAuthExpiry, setOfflineAuthorizedAt, summarizeSyncOutcome, type SyncResult } from "@/lib/offline/sync";
import { OfflineStorageError } from "@/lib/errors/friendly";
import OfflineSyncStatus from "@/components/OfflineSyncStatus";
import OfflineUnlockGate from "@/components/OfflineUnlockGate";
import {
  OfflineLockedError,
  checkOfflineIdleLock,
  isOfflineUnlocked,
  markOfflineActivity,
  markOfflineBackground,
  markOfflineForeground,
} from "@/lib/offline/unlock";
import { SkeletonPage } from "@/components/ui/Skeletons";
import { SuccessTick } from "@/components/ui/SuccessTick";
import CediAmount from "@/components/CediAmount";

interface ToVisitCustomer {
  accountId: string;
  customerName: string;
  customerIdCode: string;
  dailyContribution: number;
  outstandingDays: number;
  expectedAmount: number;
}

interface CollectedCustomer {
  accountId: string;
  customerName: string;
  customerIdCode: string;
  amountCollected: number;
  daysCovered: number;
  collectedAt: string;
}

interface RemittanceEntry {
  id: string;
  expectedAmount: number;
  remittedAmount: number;
  variance: number;
  status: string;
  createdAt: string;
}

interface DashboardData {
  assignedCustomers: number;
  todayCollected: number;
  todayCollectionCount: number;
  toVisit: ToVisitCustomer[];
  collectedToday: CollectedCustomer[];
  recentRemittances: RemittanceEntry[];
  // Cash accountability
  todayContributions: number;
  expectedToBringIn: number;
  amountHandedInToday: number;
  difference: number;
  customersCollected: number;
  customersRemaining: number;
}

interface CollectorDashboardProps {
  userId: string;
  userName: string;
  tenantId: string;
}

type SortOption = "name" | "amount" | "days";
type FilterOption = "all" | "visit" | "collected" | "pending";

function formatTime(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

// Offline is enabled per-user via device enrollment, not a global flag.
// The server checks enrollment status before allowing offline operations.

export default function CollectorDashboardPage({
  userId,
  userName,
  tenantId,
}: CollectorDashboardProps) {
  const handleRedirect = useRedirectHandler();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Errors for in-modal flows. The page-level banner sits BEHIND the full-screen
  // modal overlays, so modal actions must show their own feedback or failures
  // look like "nothing happened".
  const [collectError, setCollectError] = useState("");
  const [regError, setRegError] = useState("");
  const [quote] = useState(() => getDailyQuote("susu"));

  // Offline state
  const [isOnline, setIsOnline] = useState(true);
  const [pendingTxs, setPendingTxs] = useState<OfflineTransaction[]>([]);
  const [pendingPayloads, setPendingPayloads] = useState<Record<string, string>>({});
  const [syncing, setSyncing] = useState(false);
  const [deviceId, setDeviceId] = useState<string>("");
  const [lastSyncTime, setLastSyncTime] = useState<string>("");
  const [offlineAuthExpired, setOfflineAuthExpired] = useState(false);
  const [offlineAuthExpiry, setOfflineAuthExpiry] = useState(0);
  // `offlineEnabled` means this device is prepared. `offlineActive` means the
  // collector is actually working offline now. They are separate concepts.
  const [offlineEnabled, setOfflineEnabled] = useState(false);
  const [offlineActive, setOfflineActive] = useState(false);
  const [offlineLocked, setOfflineLocked] = useState(false);
  const [needsUnlockSetup, setNeedsUnlockSetup] = useState(false);
  const [preparingOffline, setPreparingOffline] = useState(false);
  const [usingCachedData, setUsingCachedData] = useState(false);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [queueAttention, setQueueAttention] = useState<number | null>(0);
  const [serverReachable, setServerReachable] = useState<boolean | null>(null);
  const [syncAlert, setSyncAlert] = useState<{
    tone: "success" | "warning" | "error" | "info";
    message: string;
  } | null>(null);

  // UI state
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<FilterOption>("all");
  const [sortBy, setSortBy] = useState<SortOption>("amount");

  // Collection recording
  const [recordingFor, setRecordingFor] = useState<ToVisitCustomer | null>(null);
  const [collectAmount, setCollectAmount] = useState("");
  const [collectNotes, setCollectNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // One key per collection attempt: reused online, offline and on retry.
  const collectKeyRef = useRef<string | null>(null);
  const [success, setSuccess] = useState("");
  const [successTone, setSuccessTone] = useState<"confirmed" | "saved">("confirmed");

  // Customer registration modal
  const [showRegisterModal, setShowRegisterModal] = useState(false);
  const [regFullName, setRegFullName] = useState("");
  const [regPhone, setRegPhone] = useState("");
  const [regAddress, setRegAddress] = useState("");
  const [regDailyContribution, setRegDailyContribution] = useState("");
  const [regCardFee, setRegCardFee] = useState("10");
  const [regSubmitting, setRegSubmitting] = useState(false);

  // Initialize
  useEffect(() => {
    loadData();
    return () => { stopAutoSync(); };
  }, []);

  // Close either modal with Escape, matching the rest of the product.
  useEffect(() => {
    if (!recordingFor && !showRegisterModal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || submitting || regSubmitting) return;
      if (recordingFor) { setRecordingFor(null); setCollectError(""); }
      if (showRegisterModal) { setShowRegisterModal(false); setRegError(""); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [recordingFor, showRegisterModal, submitting, regSubmitting]);

  // Connectivity listeners. Focus and visibility must read the real browser
  // state: a tab receiving focus does not prove the internet returned, and the
  // backend must answer before the page claims a verified online session.
  useEffect(() => {
    const applyReadiness = () =>
      getOfflineReadiness("susu")
        .then((readiness) => applyOfflineReadiness(readiness))
        .catch(() => undefined);

    const reconcileWhenReachable = async () => {
      const reachable = await checkConnectivity().catch(() => false);
      setServerReachable(reachable);
      if (!reachable) return;
      try {
        const readiness = await reconcileOfflineConnectivity("susu");
        applyOfflineReadiness(readiness);
        if (readiness.status === "preparation_required") {
          const result = await prepareOfflineAccess("susu");
          if (result.ok) {
            applyOfflineReadiness(await getOfflineReadiness("susu"));
          }
        }
      } catch {
        // Keep the previous local readiness; sync can still run.
      }
      await attemptSync();
    };

    const handleOnline = () => {
      setIsOnline(true);
      void reconcileWhenReachable();
    };
    const handleOffline = () => {
      setIsOnline(false);
      setServerReachable(null);
      void applyReadiness();
    };
    const handleFocusOrVisible = () => {
      const actuallyOnline = navigator.onLine;
      setIsOnline(actuallyOnline);
      if (!actuallyOnline) {
        setServerReachable(null);
        void applyReadiness();
        return;
      }
      void reconcileWhenReachable();
    };
    const handleVisibilityRefresh = () => {
      if (document.visibilityState !== "visible") return;
      handleFocusOrVisible();
    };
    const handleUnlockRequired = () => setOfflineLocked(true);
    const handleStatusChange = () => void applyReadiness();

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("focus", handleFocusOrVisible);
    window.addEventListener("maacash-offline-unlock-required", handleUnlockRequired);
    window.addEventListener("maacash-offline-status", handleStatusChange);
    window.addEventListener("maacash-offline-unlock-changed", handleStatusChange);
    document.addEventListener("visibilitychange", handleVisibilityRefresh);
    setIsOnline(navigator.onLine);
    if (navigator.onLine) void reconcileWhenReachable();
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("focus", handleFocusOrVisible);
      window.removeEventListener("maacash-offline-unlock-required", handleUnlockRequired);
      window.removeEventListener("maacash-offline-status", handleStatusChange);
      window.removeEventListener("maacash-offline-unlock-changed", handleStatusChange);
      document.removeEventListener("visibilitychange", handleVisibilityRefresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyOfflineReadiness(readiness: OfflineReadiness) {
    const prepared = readiness.status === "ready" || readiness.status === "active";
    setOfflineEnabled(prepared);
    setOfflineActive(readiness.status === "active");
    if (readiness.context?.authorizedAt) {
      setOfflineAuthorizedAt(new Date(readiness.context.authorizedAt));
    }
    if (readiness.lastSyncedAt) {
      setLastSyncTime(
        new Date(readiness.lastSyncedAt).toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
        })
      );
    }
  }

  // Resume a previously prepared device without a server request. New devices
  // are prepared automatically during normal online use.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // The server page already resolved this identity through
        // requireTenantCollector(). Seed the local scope BEFORE any IndexedDB
        // access, so the device id and queue come from this tenant/user and not
        // from a fallback prepared context belonging to another profile user.
        setOfflineScope({ tenantId, userId }, "seeded", "susu");
        const did = await getOrCreateDeviceId();
        if (cancelled) return;
        setDeviceId(did);
        await hydrateOfflineAuthorization();
        let readiness = await getOfflineReadiness("susu");
        if (cancelled) return;
        applyOfflineReadiness(readiness);

        const unlockContext = await getCurrentOfflineContext();
        const unlocked = unlockContext ? isOfflineUnlocked(unlockContext) : false;
        if (!cancelled) {
          setNeedsUnlockSetup(Boolean(unlockContext && !unlockContext.unlock));
          setOfflineLocked(
            Boolean(
              unlockContext &&
                ((unlockContext.unlock && !unlocked) ||
                  (!navigator.onLine && !unlockContext.unlock))
            )
          );
        }

        // Automatic background preparation while online. Never blocks the
        // dashboard, never bypasses the offline unlock, and never claims
        // readiness before it succeeds.
        if (
          navigator.onLine &&
          unlocked &&
          readiness.status !== "ready" &&
          readiness.status !== "active"
        ) {
          setPreparingOffline(true);
          const result = await prepareOfflineAccess("susu");
          if (!cancelled) {
            readiness = await getOfflineReadiness("susu");
            applyOfflineReadiness(readiness);
            if (!result.ok && result.message) setError(result.message);
          }
          if (!cancelled) setPreparingOffline(false);
        }

        if (!cancelled && !navigator.onLine) {
          const context = await getCurrentOfflineContext();
          if (
            context &&
            !offlineContextExpired(context) &&
            context.modules.includes("susu")
          ) {
            await startOfflineSession();
          } else if (context && offlineContextExpired(context)) {
            setOfflineAuthExpired(true);
            setError(
              "Offline access has expired. Reconnect and sign in again. Saved records remain on this device."
            );
          }
        } else if (!cancelled && readiness.status !== "preparation_required") {
          await refreshPendingTxs();
          startAutoSync(handleSyncResults);
        }
      } catch {
        /* Offline unavailable — the page still works fully online. */
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void getCurrentOfflineContext().then((context) => {
      if (
        context &&
        ((context.unlock && !isOfflineUnlocked(context)) ||
          (!navigator.onLine && !context.unlock))
      ) {
        setOfflineLocked(true);
      }
    });
  }, [isOnline]);

  // Lock the offline workspace after inactivity or a long background period.
  // Timers are best effort; visibility/focus events are also used.
  useEffect(() => {
    const activity = () => markOfflineActivity();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        markOfflineBackground();
        return;
      }
      if (markOfflineForeground()) setOfflineLocked(true);
    };
    const onFocus = () => {
      if (markOfflineForeground()) setOfflineLocked(true);
    };
    window.addEventListener("pointerdown", activity);
    window.addEventListener("keydown", activity);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    const interval = setInterval(() => {
      if (checkOfflineIdleLock()) setOfflineLocked(true);
    }, 30_000);
    return () => {
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      clearInterval(interval);
    };
  }, []);

  // Background preparation may finish after this page mounted. Reflect the
  // validated local state without asking the server.
  useEffect(() => {
    const refresh = () => {
      void getOfflineReadiness("susu")
        .then((readiness) => applyOfflineReadiness(readiness))
        .catch(() => undefined);
    };
    window.addEventListener("maacash-offline-status", refresh);
    const onUnlockSetup = () => setNeedsUnlockSetup(true);
    window.addEventListener("maacash-offline-unlock-setup", onUnlockSetup);
    return () => {
      window.removeEventListener("maacash-offline-status", refresh);
      window.removeEventListener("maacash-offline-unlock-setup", onUnlockSetup);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When connectivity is lost and the device is prepared, activate locally.
  useEffect(() => {
    if (isOnline || !offlineEnabled || offlineActive || offlineAuthExpired) return;
    void startOfflineSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, offlineEnabled, offlineActive, offlineAuthExpired]);

  // Cache the day's customer list into IndexedDB so collections can be
  // recorded and viewed without a connection.
  async function cacheCustomersForOffline() {
    try {
      setOfflineScope({ tenantId, userId }, "seeded", "susu");
      const dashboardData = (await getCollectorDashboardStats(userId)) as DashboardData | null;
      const toVisit = dashboardData?.toVisit || [];
      const customers: CachedCustomer[] = toVisit.map((c) => ({
        accountId: c.accountId,
        customerName: c.customerName,
        customerIdCode: c.customerIdCode,
        dailyContribution: c.dailyContribution,
        outstandingDays: c.outstandingDays,
        expectedAmount: c.expectedAmount,
        lastSynced: new Date().toISOString(),
      }));
      await cacheCustomers(customers);
    } catch {
      /* Non-fatal: customers will cache on the next successful sync. */
    }
  }

  // Activate offline mode. This is a local operation: no API call is made and
  // the authorization window is never extended by the tap.
  async function startOfflineSession() {
    setError("");
    const activation = await activateOfflineAccess("susu");
    applyOfflineReadiness(activation.readiness);
    if (!activation.ok) {
      if (activation.readiness.status === "expired") {
        setOfflineAuthExpired(true);
      }
      setError(activation.readiness.message);
      return false;
    }
    setOfflineEnabled(true);
    setOfflineActive(!navigator.onLine);
    setOfflineAuthExpired(false);
    await refreshPendingTxs();
    startAutoSync(handleSyncResults);
    if (navigator.onLine) await cacheCustomersForOffline();
    return true;
  }

  // First use prepares the device online during normal use. This action stays in
  // the Offline records panel, which owns preparation and queue state.

  // Periodically check the local offline authorization window.
  useEffect(() => {
    if (!offlineEnabled) return;
    const check = () => {
      void (async () => {
        const context = await getCurrentOfflineContext();
        const expired =
          isOfflineAuthExpired() ||
          (context ? offlineContextExpired(context) : false);
        setOfflineAuthExpired(expired);
        setOfflineAuthExpiry(secondsUntilOfflineAuthExpiry());
      })();
    };
    check();
    const interval = setInterval(check, 30_000);
    return () => clearInterval(interval);
  }, [offlineEnabled]);

  const handleSyncResults = useCallback((results: SyncResult[]) => {
    const outcome = summarizeSyncOutcome(results);
    if (outcome.confirmed > 0) {
      setSuccess(
        `Collection synchronized successfully. ${outcome.confirmed} record${
          outcome.confirmed === 1 ? "" : "s"
        } confirmed by the server.`
      );
      setSuccessTone("confirmed");
      loadData();
    }
    if (outcome.rejected.length > 0) {
      // A real server rejection is the only case that needs a user decision.
      const reasons = outcome.rejected
        .slice(0, 2)
        .map((item) => item.message)
        .join(" ");
      setSyncAlert({
        tone: "error",
        message: `${outcome.rejected.length} collection${
          outcome.rejected.length === 1 ? "" : "s"
        } need${outcome.rejected.length === 1 ? "s" : ""} attention. ${reasons}`,
      });
    } else if (outcome.transient > 0) {
      setSyncAlert({
        tone: "warning",
        message: `${outcome.transient} collection${
          outcome.transient === 1 ? " is" : "s are"
        } still saved on this device. Synchronization was interrupted and will retry.`,
      });
    } else if (outcome.locked) {
      setSyncAlert({
        tone: "info",
        message: "Unlock the offline workspace to synchronize saved collections.",
      });
    } else if (outcome.authExpired) {
      setSyncAlert({
        tone: "warning",
        message: "Your session expired. Sign in again to synchronize saved collections.",
      });
    } else {
      setSyncAlert(null);
    }
    refreshPendingTxs();
  }, []);

  async function refreshPendingTxs() {
    const pending = await getPendingTransactions();
    setPendingTxs(pending);
    try {
      const summary = await getOfflineQueueSummary();
      setQueueAttention(summary.attention);
    } catch {
      // An unreadable queue is not an empty queue and must not keep showing an
      // old count. The dashboard renders an explicit unavailable state.
      setQueueAttention(null);
    }
    const payloads: Record<string, string> = {};
    for (const tx of pending) {
      try {
        payloads[tx.id] = await openTransactionPayload(tx);
      } catch {
        payloads[tx.id] = "{}";
      }
    }
    setPendingPayloads(payloads);
  }

  async function attemptSync() {
    if (!navigator.onLine) return;
    const connected = await checkConnectivity();
    if (!connected) return;
    setSyncing(true);
    try {
      const results = await syncPendingTransactions({ retryExhausted: true });
      handleSyncResults(results);
    } finally {
      setSyncing(false);
      setLastSyncTime(new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }));
    }
  }

  /**
   * Offline fallback. Server-authoritative totals stay absent; the collector
   * sees only the authorized customer snapshot that was synchronized during
   * preparation, clearly marked as cached.
   */
  async function loadCachedDashboard() {
    const customers = await getCachedCustomers();
    const expectedTotal = customers.reduce(
      (sum, customer) => sum + Number(customer.expectedAmount || 0),
      0
    );
    setData({
      assignedCustomers: customers.length,
      todayCollected: 0,
      todayCollectionCount: 0,
      toVisit: customers.map((customer) => ({
        accountId: customer.accountId,
        customerName: customer.customerName,
        customerIdCode: customer.customerIdCode,
        dailyContribution: customer.dailyContribution,
        outstandingDays: customer.outstandingDays,
        expectedAmount: customer.expectedAmount,
      })),
      collectedToday: [],
      recentRemittances: [],
      todayContributions: 0,
      expectedToBringIn: expectedTotal,
      amountHandedInToday: 0,
      difference: expectedTotal,
      customersCollected: 0,
      customersRemaining: customers.length,
    });
    setCachedAt(customers[0]?.lastSynced ?? null);
    setUsingCachedData(true);
  }

  async function loadData() {
    try {
      const context = await getCurrentOfflineContext();
      const offlinePreparedForSusu = Boolean(
        context &&
          context.unlock &&
          isOfflineUnlocked(context) &&
          !offlineContextExpired(context) &&
          context.modules.includes("susu")
      );
      if (!navigator.onLine && offlinePreparedForSusu) {
        await loadCachedDashboard();
        return;
      }
      const dashboardData = (await getCollectorDashboardStats(userId)) as DashboardData | null;
      setData(dashboardData);
      setUsingCachedData(false);
    } catch (err) {
      if (handleRedirect(err, setError, "Failed to load dashboard")) return;
      // A network failure after preparation is offline operation, not a broken
      // dashboard. Fall back to the authorized local snapshot.
      const context = await getCurrentOfflineContext().catch(() => null);
      if (
        context &&
        context.unlock &&
        isOfflineUnlocked(context) &&
        !offlineContextExpired(context) &&
        context.modules.includes("susu")
      ) {
        try {
          await loadCachedDashboard();
        } catch {
          setError(
            "Saved customer data could not be opened. Your records are not deleted. Unlock the offline workspace and reload."
          );
        }
      } else {
        setError("Failed to load dashboard");
      }
    } finally { setLoading(false); }
  }

  async function handleRecordCollection() {
    if (!recordingFor || !collectAmount) return;
    setSubmitting(true); setError(""); setSuccess(""); setCollectError("");
    try {
      const amountNum = parseFloat(collectAmount);
      if (!amountNum || amountNum <= 0) { setCollectError("Enter a valid amount"); return; }

      const idempotencyKey =
        collectKeyRef.current ?? crypto.randomUUID();
      collectKeyRef.current = idempotencyKey;

      // Try online first
      if (navigator.onLine) {
        try {
          const result = await recordContribution({
            accountId: recordingFor.accountId, amount: amountNum, channel: "collector",
            notes: collectNotes || undefined,
            idempotencyKey,
          });
          if (result.success) {
            collectKeyRef.current = null;
            const resultData = result.data as { daysAllocated: number };
            setSuccessTone("confirmed");
            setSuccess(
              `Collection synchronized successfully. ${recordingFor.customerName}: ${formatCedi(amountNum)} — ${resultData.daysAllocated} day(s) covered.`
            );
            setRecordingFor(null); setCollectAmount(""); setCollectNotes("");
            loadData();
            return;
          }
          // The server answered and rejected the record (validation, assignment,
          // cycle rules). Do not queue a rejected record as if it were pending.
          collectKeyRef.current = null;
          setCollectError(result.error || "This collection could not be recorded.");
          return;
        } catch (err) {
          if (handleRedirect(err, setCollectError, "Something went wrong. Please try again.")) return;
          // A genuine network failure falls through to the offline queue.
        }
      }

      // Offline: queue the transaction with the same key as the online attempt.
      if (offlineEnabled && deviceId) {
        const scope = await getOfflineScope().catch(() => null);
        const tx: OfflineTransaction = {
          id: crypto.randomUUID(),
          deviceId,
          tenantId: scope?.tenantId,
          userId,
          type: "contribution",
          idempotencyKey,
          payload: JSON.stringify({
            accountId: recordingFor.accountId,
            amount: amountNum,
            channel: "collector",
            notes: collectNotes || undefined,
          }),
          status: "pending_sync",
          retryCount: 0,
          maxRetries: 5,
          failureReason: null,
          serverResult: null,
          localTimestamp: new Date().toISOString(),
          syncStartedAt: null,
          syncedAt: null,
          createdAt: new Date().toISOString(),
        };
        try {
          await addTransaction(tx);
        } catch (err) {
          if (err instanceof OfflineLockedError) {
            setOfflineLocked(true);
            setCollectError(
              "The offline workspace locked before this record could be saved. Unlock it and record the collection again."
            );
            return;
          }
          const quota = err instanceof OfflineStorageError && err.code === "storage_full";
          setCollectError(
            quota
              ? "This device has run out of storage for offline records. Synchronize or free space, then try again."
              : "This device could not save the record. Keep this page open and try again."
          );
          return;
        }
        collectKeyRef.current = null;
        setSuccessTone("saved");
        setSuccess(
          `Saved on this device — pending synchronization.\n${recordingFor.customerName}: ${formatCedi(amountNum)}. Not yet in the central ledger.`
        );
        setRecordingFor(null); setCollectAmount(""); setCollectNotes("");
        refreshPendingTxs();
      } else if (!navigator.onLine) {
        setCollectError(
          "This device needs an initial online setup before it can save collections offline. Saved records already on the device are not affected."
        );
      } else {
        setCollectError("Unable to record. Check your connection and try again.");
      }
    } catch (err) { if (handleRedirect(err, setCollectError, "Something went wrong. Please try again.")) return;
    } finally { setSubmitting(false); }
  }

  async function handleRegisterCustomer() {
    if (!regFullName.trim() || !regDailyContribution) {
      setRegError("Please fill in all required fields");
      return;
    }

    const dailyContributionNum = parseFloat(regDailyContribution);
    if (!dailyContributionNum || dailyContributionNum <= 0) {
      setRegError("Daily contribution must be greater than 0");
      return;
    }

    const cardFeeNum = parseFloat(regCardFee) || 10;

    setRegSubmitting(true);
    setError("");
    setSuccess("");
    setRegError("");

    try {
      const result = await registerCustomerByCollector({
        fullName: regFullName.trim(),
        phone: regPhone.trim() || undefined,
        address: regAddress.trim() || undefined,
        dailyContribution: dailyContributionNum,
        cardFee: cardFeeNum,
      });

      if (result.success) {
        const data = result.data as { customer: { customerId: string; fullName: string }; susuAccount: { accountId: string } };
        setSuccess(
          `Customer Account Created Successfully. ${data.customer.fullName} — Account Number ${data.customer.customerId} — Daily ${formatCedi(dailyContributionNum)}/day`
        );
        setShowRegisterModal(false);
        setRegFullName("");
        setRegPhone("");
        setRegAddress("");
        setRegDailyContribution("");
        setRegCardFee("10");
        loadData();
      } else {
        setRegError(result.error || "Failed to register customer");
      }
    } catch (err) { if (handleRedirect(err, setRegError, "Something went wrong. Please try again.")) return;
    } finally {
      setRegSubmitting(false);
    }
  }

  // Filtered + sorted data
  const filteredToVisit = useMemo(() => {
    if (!data) return [];
    let list = data.toVisit;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(c => c.customerName.toLowerCase().includes(q) || c.customerIdCode.toLowerCase().includes(q));
    }
    if (sortBy === "name") list = [...list].sort((a, b) => a.customerName.localeCompare(b.customerName));
    else if (sortBy === "amount") list = [...list].sort((a, b) => b.expectedAmount - a.expectedAmount);
    else if (sortBy === "days") list = [...list].sort((a, b) => b.outstandingDays - a.outstandingDays);
    return list;
  }, [data, searchQuery, sortBy]);

  const filteredCollected = useMemo(() => {
    if (!data) return [];
    let list = data.collectedToday;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(c => c.customerName.toLowerCase().includes(q) || c.customerIdCode.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => new Date(b.collectedAt).getTime() - new Date(a.collectedAt).getTime());
  }, [data, searchQuery]);

  if (offlineLocked) {
    return (
      <div className="mx-auto max-w-md py-10">
        <OfflineUnlockGate
          allowSetup={false}
          fallbackContext={{ tenantId, userId, userName }}
          onUnlocked={() => {
            setOfflineLocked(false);
            void loadData();
            void refreshPendingTxs();
          }}
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="px-1 py-2">
        <SkeletonPage variant="dashboard" />
      </div>
    );
  }
  if (error && !data) return <div role="alert" className="banner banner-error">{error}</div>;

  const totalAssigned = data?.assignedCustomers || 0;
  const collected = data?.collectedToday.length || 0;
  const remaining = data?.toVisit.length || 0;
  const allDone = remaining === 0 && totalAssigned > 0;
  const showVisit = filter === "all" || filter === "visit";
  const showCollected = filter === "all" || filter === "collected";
  const showPending = filter === "pending";

  return (
    <div className="space-y-5">
      {/* Header: one primary business action plus a compact, non-duplicated status area. */}
      <div className="card !p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-slate-900">{getGreeting()}, {userName || "Collector"}</h1>
            <p className="text-sm text-green-600 italic mt-1">&ldquo;{quote}&rdquo;</p>
          </div>
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:items-end">
            <button
              type="button"
              onClick={() => { setShowRegisterModal(true); setRegError(""); }}
              className="btn btn-primary w-full text-sm sm:w-auto"
            >
              <UserPlus size={15} aria-hidden />Register New Customer
            </button>

            <div className="flex flex-wrap items-center gap-2 sm:justify-end" aria-label="Workspace status">
              <span className={`badge ${!isOnline ? "badge-yellow" : serverReachable === false ? "badge-red" : "badge-green"}`}>
                <span className={`h-2 w-2 rounded-full ${!isOnline ? "bg-yellow-500" : serverReachable === false ? "bg-red-500" : "bg-green-500"}`} aria-hidden />
                {!isOnline ? "Offline" : serverReachable === false ? "Server unreachable" : "Online"}
              </span>

              <span className={`badge ${offlineAuthExpired ? "badge-red" : !isOnline && offlineEnabled ? "badge-yellow" : offlineEnabled ? "badge-green" : "badge-blue"}`}>
                {offlineAuthExpired
                  ? "Reconnect required"
                  : !offlineEnabled
                    ? needsUnlockSetup
                      ? "Offline setup required"
                      : "Offline not set up"
                    : !isOnline
                      ? "Working offline"
                      : "Offline available"}
              </span>

              {queueAttention === null ? (
                <span className="badge badge-red">Queue unreadable</span>
              ) : queueAttention > 0 ? (
                <span className="badge badge-red">{queueAttention} need attention</span>
              ) : pendingTxs.length > 0 ? (
                <span className="badge badge-yellow">
                  {pendingTxs.length} waiting to sync
                </span>
              ) : (
                <span className="badge badge-gray">Queue clear</span>
              )}
            </div>

            <p className="text-xs text-slate-500">
              {preparingOffline
                ? "Preparing offline access…"
                : lastSyncTime
                  ? `Last successful sync ${lastSyncTime}`
                  : "No successful synchronization yet"}
              {!isOnline && !offlineAuthExpired && offlineAuthExpiry > 0
                ? ` · Authorization expires in ${Math.floor(offlineAuthExpiry / 3600)}h${Math.floor((offlineAuthExpiry % 3600) / 60)}m`
                : ""}
            </p>
          </div>
        </div>
      </div>

      {/* Messages */}
      {success &&
        (successTone === "confirmed" ? (
          <div role="status" aria-live="polite" className="banner banner-success text-sm flex items-center gap-3">
            <SuccessTick size={26} label="Collection synchronized" />
            <span className="min-w-0 whitespace-pre-line">{success}</span>
          </div>
        ) : (
          <div role="status" aria-live="polite" className="banner banner-warning !rounded-xl text-sm flex items-start gap-3">
            <Clock size={20} className="mt-0.5 flex-none text-yellow-700" aria-hidden />
            <span className="min-w-0 whitespace-pre-line text-yellow-900">{success}</span>
          </div>
        ))}
      {syncAlert && (
        <div
          role={syncAlert.tone === "error" ? "alert" : "status"}
          aria-live="polite"
          className={`banner text-sm ${
            syncAlert.tone === "error"
              ? "banner-error"
              : syncAlert.tone === "success"
                ? "banner-success"
                : syncAlert.tone === "warning"
                  ? "banner-warning"
                  : "banner-info"
          }`}
        >
          {syncAlert.message}
        </div>
      )}
      {queueAttention !== null && queueAttention > 0 && syncAlert?.tone !== "error" && (
        <div role="alert" className="banner banner-error text-sm">
          {queueAttention} collection{queueAttention === 1 ? "" : "s"} need
          {queueAttention === 1 ? "s" : ""} attention. The exact server reason is listed
          under Offline records.
        </div>
      )}
      {queueAttention === null && (
        <div role="status" className="banner banner-warning text-sm">
          The offline queue could not be read. Saved records are not deleted, and no
          attention count is available until the queue can be read again. Reload or open
          Offline records to retry.
        </div>
      )}
      {error && <div role="alert" className="banner banner-error text-sm">{error}</div>}

      {usingCachedData && (
        <div className="banner banner-warning !rounded-xl text-sm" role="status">
          <p className="font-medium text-yellow-900">
            Working offline. Showing customer information saved on this device.
          </p>
          <p className="mt-1 text-xs text-yellow-800">
            {cachedAt
              ? `Last synchronized ${new Date(cachedAt).toLocaleString("en-GB", {
                  day: "2-digit",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}. Customer balances may have changed since then.`
              : "This information may be outdated. It is not live server data."}
          </p>
        </div>
      )}

      {needsUnlockSetup && isOnline && (
        <div className="mb-4">
          <OfflineUnlockGate
            allowSetup
            fallbackContext={{ tenantId, userId, userName }}
            onUnlocked={() => {
              setNeedsUnlockSetup(false);
              void (async () => {
                await prepareOfflineAccess("susu");
                applyOfflineReadiness(await getOfflineReadiness("susu"));
                await refreshPendingTxs();
              })();
            }}
          />
        </div>
      )}

      <OfflineSyncStatus module="susu" />

      {/* Pending Sync Banner */}
      {pendingTxs.length > 0 && (
        <div className="banner banner-warning !rounded-xl items-center justify-between">
          <div className="flex items-center gap-3">
            <RefreshCw size={20} className="text-yellow-600" aria-hidden />
            <div>
              <p className="font-medium text-yellow-800">
                {pendingTxs.length} collection{pendingTxs.length !== 1 ? "s" : ""} saved on this device — not yet synced
              </p>
              <p className="text-xs text-yellow-700">
                These records are not in the central ledger until the server confirms them.
              </p>
            </div>
          </div>
          {isOnline && (
            <button onClick={attemptSync} disabled={syncing} className="btn btn-secondary btn-sm">
              {syncing ? "Syncing..." : "Sync Now"}
            </button>
          )}
        </div>
      )}

      {/* Today's Money — Cash Accountability */}
      {data && (
        <div className="card !p-5">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Wallet size={17} className="text-brand-600" aria-hidden />
            Today&apos;s Money — Cash Accountability
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-green-50 rounded-lg p-4">
              <div className="text-xs text-green-600 font-medium">Today&apos;s Contributions</div>
              <div className="text-2xl font-bold text-green-800 mt-1"><CediAmount amount={data.todayContributions} /></div>
              <button
                type="button"
                className="mt-2 text-xs text-green-700 hover:underline flex items-center gap-1"
                onClick={() => setError("")}
              >
                <Info size={13} className="flex-none" aria-hidden /> Total customer payments you have successfully recorded today.
              </button>
            </div>
            <div className="bg-blue-50 rounded-lg p-4">
              <div className="text-xs text-blue-600 font-medium">Expected to Bring In</div>
              <div className="text-2xl font-bold text-blue-800 mt-1"><CediAmount amount={data.expectedToBringIn} /></div>
              <button
                type="button"
                className="mt-2 text-xs text-blue-700 hover:underline flex items-center gap-1"
              >
                <Info size={13} className="flex-none" aria-hidden /> Money from today&apos;s customer collections that you are expected to hand to the business.
              </button>
            </div>
            <div className="bg-purple-50 rounded-lg p-4">
              <div className="text-xs text-purple-600 font-medium">Amount Handed In</div>
              <div className="text-2xl font-bold text-purple-800 mt-1"><CediAmount amount={data.amountHandedInToday} /></div>
              <button
                type="button"
                className="mt-2 text-xs text-purple-700 hover:underline flex items-center gap-1"
              >
                <Info size={13} className="flex-none" aria-hidden /> Money you have already brought to the business today.
              </button>
            </div>
            <div className={`rounded-lg p-4 ${data.difference > 0 ? "bg-red-50" : "bg-green-50"}`}>
              <div className="text-xs font-medium text-slate-600">
                {data.difference > 0 ? "Still to hand in" : data.difference < 0 ? "Over-handed" : "Hand-in balances"}
              </div>
              <div className={`text-2xl font-bold mt-1 ${data.difference > 0 ? "text-red-700" : "text-green-700"}`}>
                <CediAmount amount={Math.abs(data.difference)} />
              </div>
              <button
                type="button"
                className="mt-2 text-xs text-slate-700 hover:underline flex items-center gap-1"
              >
                <Info size={13} className="flex-none" aria-hidden /> The difference between the money you are expected to bring in and the money you have handed in.
              </button>
            </div>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Collected today <span className="font-semibold text-slate-700"><CediAmount amount={data.todayContributions} /></span>
            {" · "}handed in <span className="font-semibold text-slate-700"><CediAmount amount={data.amountHandedInToday} /></span>
            {" · "}still to hand in <span className={`font-semibold ${data.difference > 0 ? "text-red-700" : "text-slate-700"}`}><CediAmount amount={Math.max(0, data.difference)} /></span>
          </p>
          <div className="grid grid-cols-2 gap-4 mt-4 pt-4 border-t border-slate-100">
            <div className="bg-slate-50 rounded-lg p-3 text-center">
              <div className="text-xs text-slate-500">Customers Collected</div>
              <div className="text-xl font-bold text-green-700">{data.customersCollected}</div>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 text-center">
              <div className="text-xs text-slate-500">Customers Remaining</div>
              <div className="text-xl font-bold text-orange-600">{data.customersRemaining}</div>
            </div>
          </div>
        </div>
      )}

      {/* Progress */}
      {data && (
        <div className="card !p-5">
          <h2 className="text-lg font-semibold mb-3">Today&apos;s Collections</h2>
          {allDone && pendingTxs.length === 0 ? (
            <div className="text-center py-2">
              <CheckCircle2 className="mx-auto text-emerald-600 mb-1" size={26} aria-hidden />
              <p className="font-semibold text-green-700">All collections completed!</p>
              <p className="text-sm text-slate-500 mt-1">{totalAssigned} of {totalAssigned} customers collected</p>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div className="text-center flex-1">
                <div className="text-2xl font-bold text-green-700">{collected}</div>
                <div className="text-xs text-slate-500">Collected</div>
              </div>
              <div className="text-slate-300 text-xl">·</div>
              <div className="text-center flex-1">
                <div className="text-2xl font-bold text-orange-600">{remaining}</div>
                <div className="text-xs text-slate-500">Remaining</div>
              </div>
              <div className="text-slate-300 text-xl">·</div>
              <div className="text-center flex-1">
                <div className="text-2xl font-bold text-slate-700"><CediAmount amount={data.todayCollected} /></div>
                <div className="text-xs text-slate-500">Collected Today</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Search + Filters + Sort */}
      {data && (
        <div className="bg-white rounded-xl p-4 shadow-sm border border-slate-100">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1">
              <input type="text" placeholder="Search customers..." value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-green-400" />
            </div>
            <div className="flex gap-1 flex-wrap">
              {(["all", "visit", "collected"] as const).map((f) => (
                <button key={f} onClick={() => setFilter(f)}
                  className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors ${filter === f ? "bg-green-100 text-green-700" : "bg-slate-50 text-slate-500 hover:bg-slate-100"}`}>
                  {f === "all" ? "All" : f === "visit" ? "To Visit" : "Collected"}
                </button>
              ))}
              {offlineEnabled && pendingTxs.length > 0 && (
                <button onClick={() => setFilter("pending")}
                  className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors ${filter === "pending" ? "bg-yellow-100 text-yellow-700" : "bg-slate-50 text-slate-500 hover:bg-slate-100"}`}>
                  Pending ({pendingTxs.length})
                </button>
              )}
            </div>
            {showVisit && remaining > 0 && (
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortOption)}
                className="px-3 py-2 border border-slate-200 rounded-lg text-xs text-slate-600">
                <option value="amount">Sort: Amount</option>
                <option value="days">Sort: Days Due</option>
                <option value="name">Sort: Name</option>
              </select>
            )}
          </div>
        </div>
      )}

      {/* TO VISIT — Grid */}
      {data && showVisit && filteredToVisit.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-1 px-1">To Visit</h2>
          <p className="text-sm text-slate-500 mb-3 px-1">{filteredToVisit.length} customer{filteredToVisit.length !== 1 ? "s" : ""} remaining</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filteredToVisit.map((customer) => (
              <div key={customer.accountId} className="bg-white rounded-xl p-4 shadow-sm border border-slate-100 hover:border-green-300 transition-colors flex flex-col">
                <div className="flex-1">
                  <div className="font-medium text-sm truncate" title={customer.customerName}>{customer.customerName}</div>
                  <div className="text-xs text-slate-400 mb-2">{customer.customerIdCode}</div>
                  <div className="flex justify-between text-xs text-slate-500 mb-1">
                    <span>Daily: <CediAmount amount={customer.dailyContribution} /></span>
                    <span>{customer.outstandingDays}d due</span>
                  </div>
                  <div className="font-semibold text-sm text-green-700"><CediAmount amount={customer.expectedAmount} /></div>
                </div>
                <button onClick={() => { setRecordingFor(customer); setCollectAmount(String(customer.expectedAmount)); setCollectError(""); }}
                  className="btn btn-primary btn-sm w-full mt-3">Collect</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty search */}
      {data && showVisit && searchQuery && filteredToVisit.length === 0 && remaining > 0 && (
        <div className="text-center py-6 text-slate-500"><p className="text-sm">No customers matching &ldquo;{searchQuery}&rdquo;</p></div>
      )}

      {/* All caught up is already announced by the Today's Collections card. */}

      {/* Pending Sync List */}
      {showPending && pendingTxs.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-1 px-1">Pending Sync</h2>
          <p className="text-sm text-slate-500 mb-3 px-1">{pendingTxs.length} collection{pendingTxs.length !== 1 ? "s" : ""} saved on device</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {pendingTxs.map((tx) => {
              const payload = JSON.parse(pendingPayloads[tx.id] ?? tx.payload ?? "{}");
              const cust = data?.toVisit.find((c) => c.accountId === payload.accountId) || data?.collectedToday.find((c) => c.accountId === payload.accountId);
              return (
                <div key={tx.id} className="bg-yellow-50 rounded-xl p-4 border border-yellow-200">
                  <div className="flex items-center gap-2 mb-1">
                    <Clock size={14} className="text-yellow-600" aria-hidden />
                    <span className="font-medium text-sm truncate">{cust?.customerName || "Customer"}</span>
                  </div>
                  <div className="font-semibold text-sm text-yellow-800"><CediAmount amount={payload.amount} /></div>
                  <div className="mt-1 text-xs font-semibold text-yellow-800">
                    Saved on Device — Not Yet Synced
                  </div>
                  <div className="text-xs text-yellow-600">
                    Saved {formatTime(tx.localTimestamp)} · {tx.retryCount > 0 ? `Retry ${tx.retryCount}/${tx.maxRetries}` : "Waiting to synchronize"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* COLLECTED TODAY — Grid */}
      {data && showCollected && filteredCollected.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-1 px-1">Collected Today</h2>
          <p className="text-sm text-slate-500 mb-3 px-1">{filteredCollected.length} customer{filteredCollected.length !== 1 ? "s" : ""} collected</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filteredCollected.map((customer) => (
              <div key={customer.accountId} className="bg-green-50 rounded-xl p-4 border border-green-100">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-green-600">✓</span>
                  <span className="font-medium text-sm truncate">{customer.customerName}</span>
                </div>
                <div className="text-xs text-slate-400 mb-2">{customer.customerIdCode}</div>
                <div className="font-semibold text-sm text-green-700"><CediAmount amount={customer.amountCollected} /></div>
                <div className="text-xs text-slate-500 mt-1">
                  {customer.daysCovered} day{customer.daysCovered !== 1 ? "s" : ""} covered · {formatTime(customer.collectedAt)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Money Handed In */}
      {data && data.recentRemittances.length > 0 && (
        <div className="card !p-5">
          <h2 className="text-lg font-semibold mb-4">Recent Money Handed In</h2>
          <div className="space-y-2">
            {data.recentRemittances.map((r) => (
              <div key={r.id} className="flex justify-between items-center p-2 rounded-lg bg-slate-50">
                <div className="text-sm">
                  <span className="font-mono"><CediAmount amount={r.remittedAmount} /></span>
                  {r.variance !== 0 && (
                    <span className={`ml-2 text-xs ${r.variance > 0 ? "text-red-600" : "text-green-600"}`}>
                      ({r.variance > 0 ? "Short " : "Over "}<CediAmount amount={Math.abs(r.variance)} />)
                    </span>
                  )}
                </div>
                <span className={`badge ${r.status === "reconciled" ? "badge-green" : "badge-red"}`}>
                  {r.status === "reconciled" ? "Matches" : "Short"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recording Modal */}
      {recordingFor && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/60 p-0 backdrop-blur-sm md:items-center md:p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="collect-title"
            className="w-full max-w-md max-h-[92dvh] overflow-y-auto overscroll-contain rounded-t-2xl bg-white p-5 shadow-xl pb-[max(1.25rem,env(safe-area-inset-bottom))] md:rounded-xl md:p-6"
          >
            <h3 id="collect-title" className="text-lg font-semibold mb-2">Record Collection</h3>
            <div className="bg-green-50 rounded-lg p-3 mb-4">
              <div className="font-medium">{recordingFor.customerName}</div>
              <div className="text-sm text-slate-600">
                {recordingFor.outstandingDays} day{recordingFor.outstandingDays !== 1 ? "s" : ""} due · Expected: <CediAmount amount={recordingFor.expectedAmount} />
              </div>
            </div>
            {!isOnline && offlineEnabled && offlineAuthExpired && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-2 mb-4 text-xs text-red-700">
                Reconnect to the internet and sign in again before continuing offline work.
              </div>
            )}
            {!isOnline && offlineEnabled && !offlineAuthExpired && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-2 mb-4 text-xs text-yellow-700">
                You&apos;re working offline. This collection will be saved on your
                device as <strong>Saved on Device — Not Yet Synced</strong>, then
                synchronized when internet returns.
              </div>
            )}
            {!isOnline && !offlineEnabled && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-2 mb-4 text-xs text-red-700">
                This device has not been prepared for offline collection. Reconnect
                once and let preparation finish. Existing saved records are not
                affected.
              </div>
            )}
            {collectError && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-2 mb-4 text-xs text-red-700">
                {collectError}
              </div>
            )}
            <div className="form-group">
              <label className="form-label" htmlFor="collect-amount">Amount Received (GH₵)</label>
              <input id="collect-amount" type="number" step="0.01" min="0.01" inputMode="decimal" value={collectAmount}
                onChange={(e) => setCollectAmount(e.target.value)} className="text-lg" />
              <p className="form-hint">
                Will cover ~{Math.floor(parseFloat(collectAmount || "0") / recordingFor.dailyContribution)} day(s)
              </p>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="collect-notes">Note (optional)</label>
              <input id="collect-notes" type="text" value={collectNotes} onChange={(e) => setCollectNotes(e.target.value)} placeholder="Any note..." />
            </div>
            <div className="flex gap-3 mt-4">
              <button
                onClick={handleRecordCollection}
                className="btn btn-primary flex-1"
                disabled={
                  submitting ||
                  (!isOnline && !offlineEnabled) ||
                  (!isOnline && offlineEnabled && offlineAuthExpired)
                }
              >
                {submitting
                  ? "Recording..."
                  : !isOnline && offlineEnabled
                    ? offlineAuthExpired
                      ? "Reconnect Required"
                      : "Save on Device"
                    : "Record Contribution"}
              </button>
              <button onClick={() => { setRecordingFor(null); setCollectAmount(""); setCollectError(""); }} className="btn btn-secondary flex-1">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Register New Customer Modal */}
      {showRegisterModal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/60 p-0 backdrop-blur-sm md:items-center md:p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="register-title"
            className="w-full max-w-md max-h-[92dvh] overflow-y-auto overscroll-contain rounded-t-2xl bg-white p-5 shadow-xl pb-[max(1.25rem,env(safe-area-inset-bottom))] md:rounded-xl md:p-6"
          >
            <h3 id="register-title" className="text-lg font-semibold mb-2">Register New Customer</h3>
            {!isOnline && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-2 mb-4 text-xs text-yellow-700">
                You&apos;re offline. Customer registration requires an internet connection.
              </div>
            )}
            {regError && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-2 mb-4 text-xs text-red-700">
                {regError}
              </div>
            )}
            <div className="form-group">
              <label className="form-label" htmlFor="reg-full-name">Full Name *</label>
              <input id="reg-full-name" type="text" autoComplete="name" autoFocus value={regFullName} onChange={(e) => setRegFullName(e.target.value)} placeholder="Customer's full name" className="text-lg" disabled={!isOnline} />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="reg-phone">Phone</label>
              <input id="reg-phone" type="tel" autoComplete="tel" value={regPhone} onChange={(e) => setRegPhone(e.target.value)} placeholder="+233 XX XXX XXXX" disabled={!isOnline} />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="reg-address">Address (optional)</label>
              <input id="reg-address" type="text" autoComplete="street-address" value={regAddress} onChange={(e) => setRegAddress(e.target.value)} placeholder="Customer's address" disabled={!isOnline} />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="reg-daily">Daily Contribution (GH₵) *</label>
              <input id="reg-daily" type="number" step="0.01" min="0.01" inputMode="decimal" value={regDailyContribution} onChange={(e) => setRegDailyContribution(e.target.value)} placeholder="e.g. 50" className="text-lg" disabled={!isOnline} />
              <p className="form-hint">The amount the customer commits to save per day</p>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="reg-card-fee">Card Fee (GH₵)</label>
              <input id="reg-card-fee" type="number" step="0.01" min="0" inputMode="decimal" value={regCardFee} onChange={(e) => setRegCardFee(e.target.value)} placeholder="10" disabled={!isOnline} />
              <p className="form-hint">Standard card fee is GH₵10</p>
            </div>
            <div className="flex gap-3 mt-4">
              <button onClick={handleRegisterCustomer} className="btn btn-primary flex-1" disabled={regSubmitting || !isOnline}>
                {regSubmitting ? "Registering..." : "Register Customer"}
              </button>
              <button onClick={() => { setShowRegisterModal(false); setRegFullName(""); setRegPhone(""); setRegAddress(""); setRegDailyContribution(""); setRegCardFee("10"); setRegError(""); }} className="btn btn-secondary flex-1">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
