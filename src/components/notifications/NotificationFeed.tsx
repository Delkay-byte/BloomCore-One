"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
  resolveNotificationAction,
  type NotificationRow,
} from "@/lib/actions/notification.actions";

const severityStyles: Record<string, string> = {
  critical: "border-red-200 bg-red-50",
  attention: "border-amber-200 bg-amber-50",
  info: "border-slate-200 bg-white",
};

/**
 * Dashboard notifications. System events and AI insights are labelled
 * differently so a Zeli-generated insight can never pass as a verified event.
 */
export default function NotificationFeed({
  audience,
  items,
  unread,
}: {
  audience: "tenant" | "platform";
  items: NotificationRow[];
  unread: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">
          Notifications {unread > 0 && <span className="ml-1 text-xs font-medium text-brand-700">{unread} new</span>}
        </h2>
        {unread > 0 && (
          <button
            type="button"
            className="text-xs font-medium text-brand-700 underline disabled:opacity-50"
            disabled={busy}
            onClick={() => run(() => markAllNotificationsReadAction(audience))}
          >
            Mark all as read
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <p className="mt-3 text-sm text-slate-600">Nothing needs your attention right now.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((item) => (
            <li key={item.id} className={`rounded-lg border p-3 ${severityStyles[item.severity] ?? severityStyles.info}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900">
                    {item.title}
                    {item.readAt === null && (
                      <span className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-brand-600 align-middle" aria-label="Unread" />
                    )}
                  </p>
                  <p className="mt-1 text-sm text-slate-700">{item.body}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    <span className="uppercase tracking-wide">
                      {item.kind === "insight" ? "AI insight" : "Verified system event"}
                    </span>
                    {" · "}
                    {new Date(item.createdAt).toLocaleString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1 text-xs">
                  {item.href && (
                    <Link
                      href={item.href}
                      className="font-medium text-brand-700 underline"
                      onClick={() => {
                        if (item.readAt === null) void markNotificationReadAction(audience, item.id);
                      }}
                    >
                      Open
                    </Link>
                  )}
                  {item.readAt === null && (
                    <button
                      type="button"
                      className="text-slate-500 underline disabled:opacity-50"
                      disabled={busy}
                      onClick={() => run(() => markNotificationReadAction(audience, item.id))}
                    >
                      Mark read
                    </button>
                  )}
                  <button
                    type="button"
                    className="text-slate-500 underline disabled:opacity-50"
                    disabled={busy}
                    onClick={() => run(() => resolveNotificationAction(audience, item.id))}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
