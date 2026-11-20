"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageCircle, RefreshCw, Save, ShieldAlert, ShieldCheck } from "lucide-react";
import Notice from "@/components/ui/Notice";
import {
  getMessagingSettings,
  saveMessagingSettings,
  saveMessagingTemplate,
  type MessagingSettingsView,
} from "@/lib/actions/messaging-settings.actions";
import type { MessagingChannel, MessagingPurpose } from "@/lib/messaging/config";

const PURPOSE_LABELS: Record<MessagingPurpose, string> = {
  receipt: "Transaction receipt",
  statement: "Account statement",
  dispute_update: "Complaint update",
};

const STATUS_LABELS: Record<"draft" | "approved" | "rejected", string> = {
  draft: "Draft",
  approved: "Approved by provider",
  rejected: "Rejected",
};

/**
 * Message delivery settings for this business.
 *
 * Everything here narrows what the deployment allows. The screen shows the
 * platform state beside the business switches, so nobody can believe messages
 * are going out when the provider is not configured or a template is not
 * approved.
 */
export default function MessagingSettingsPage() {
  const [view, setView] = useState<MessagingSettingsView | null>(null);
  const [whatsappEnabled, setWhatsappEnabled] = useState(false);
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [language, setLanguage] = useState("en_US");
  const [senderId, setSenderId] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [templateChannel, setTemplateChannel] = useState<MessagingChannel>("whatsapp");
  const [templatePurpose, setTemplatePurpose] = useState<MessagingPurpose>("receipt");
  const [templateKey, setTemplateKey] = useState("maacash_receipt");
  const [templateLanguage, setTemplateLanguage] = useState("en_US");
  const [templateStatus, setTemplateStatus] = useState<"draft" | "approved" | "rejected">(
    "approved"
  );

  const apply = useCallback((next: MessagingSettingsView) => {
    setView(next);
    setWhatsappEnabled(next.whatsappEnabled);
    setSmsEnabled(next.smsEnabled);
    setTemplateName(next.whatsappTemplateName ?? "");
    setLanguage(next.whatsappTemplateLanguage ?? "en_US");
    setSenderId(next.smsSenderId ?? "");
    setNote(next.note ?? "");
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await getMessagingSettings();
      if (result.success && result.data) apply(result.data);
      else setError(result.error ?? "Messaging settings could not be loaded.");
    } catch {
      setError("Messaging settings could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    setError("");
    setSuccess("");
    const result = await saveMessagingSettings({
      whatsappEnabled,
      smsEnabled,
      whatsappTemplateName: templateName,
      whatsappTemplateLanguage: language,
      smsSenderId: senderId,
      note,
    });
    if (!result.success || !result.data) {
      setError(result.error ?? "Messaging settings could not be saved.");
    } else {
      apply(result.data);
      setSuccess("Messaging settings saved.");
    }
    setBusy(false);
  }

  async function saveTemplate() {
    setBusy(true);
    setError("");
    setSuccess("");
    const result = await saveMessagingTemplate({
      channel: templateChannel,
      purpose: templatePurpose,
      name: templateKey,
      language: templateLanguage,
      status: templateStatus,
    });
    if (!result.success || !result.data) {
      setError(result.error ?? "The template could not be saved.");
    } else {
      apply(result.data);
      setSuccess(`Template saved as ${STATUS_LABELS[templateStatus].toLowerCase()}.`);
    }
    setBusy(false);
  }

  if (loading) {
    return <p className="p-6 text-sm text-slate-500">Loading messaging settings…</p>;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Message delivery</h1>
          <p className="mt-1 text-sm text-slate-600">
            Decide whether this business sends transactional receipts, and with which
            approved template. Nothing is sent until both the platform and this business
            allow it.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="btn btn-secondary btn-sm"
        >
          <RefreshCw size={14} aria-hidden /> Refresh
        </button>
      </header>

      {error && <Notice type="error">{error}</Notice>}
      {success && <Notice type="success">{success}</Notice>}

      {view && (
        <section className="card space-y-2 p-4" aria-label="Platform readiness">
          <h2 className="font-semibold text-slate-900">Platform readiness</h2>
          <ul className="space-y-1 text-xs text-slate-600">
            <li>
              WhatsApp provider:{" "}
              {view.platform.whatsappConfigured && view.platform.whatsappDeliveryEnabled
                ? "configured and switched on"
                : "not configured for this deployment"}
            </li>
            <li>SMS provider: {view.platform.smsReady ? "ready" : "no approved provider"}</li>
          </ul>
          <p className="text-[11px] text-slate-500">
            A provider that is not configured reports messages as simulated, never as
            delivered.
          </p>
        </section>
      )}

      <section className="card space-y-3 p-4">
        <div className="flex items-start gap-3">
          <MessageCircle size={18} className="mt-0.5 shrink-0 text-brand-700" aria-hidden />
          <div className="flex-1 space-y-3">
            <h2 className="font-semibold text-slate-900">Channels for this business</h2>
            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={whatsappEnabled}
                onChange={(event) => setWhatsappEnabled(event.target.checked)}
                className="mt-0.5"
              />
              <span>Send receipts over WhatsApp</span>
            </label>
            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={smsEnabled}
                onChange={(event) => setSmsEnabled(event.target.checked)}
                className="mt-0.5"
              />
              <span>Send receipts over SMS</span>
            </label>

            <label className="block text-xs font-medium text-slate-600">
              WhatsApp receipt template name
              <input
                value={templateName}
                onChange={(event) => setTemplateName(event.target.value)}
                placeholder="maacash_receipt"
                className="input mt-1 w-full"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs font-medium text-slate-600">
                Template language
                <input
                  value={language}
                  onChange={(event) => setLanguage(event.target.value)}
                  placeholder="en_US"
                  className="input mt-1 w-full"
                />
              </label>
              <label className="block text-xs font-medium text-slate-600">
                SMS sender ID
                <input
                  value={senderId}
                  onChange={(event) => setSenderId(event.target.value)}
                  placeholder="MAACASH"
                  className="input mt-1 w-full"
                />
              </label>
            </div>
            <label className="block text-xs font-medium text-slate-600">
              Why these settings (optional, kept in the audit trail)
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
                className="input mt-1 w-full"
              />
            </label>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="btn btn-primary btn-sm"
            >
              <Save size={14} aria-hidden /> {busy ? "Saving…" : "Save settings"}
            </button>

            {view && (
              <div className="space-y-1 text-xs">
                {(["whatsapp", "sms"] as const).map((channel) => {
                  const state = view.effective[channel];
                  return (
                    <p
                      key={channel}
                      className={state.allowed ? "text-emerald-700" : "text-amber-700"}
                    >
                      {state.allowed ? <ShieldCheck size={12} aria-hidden /> : (
                        <ShieldAlert size={12} aria-hidden />
                      )}{" "}
                      {channel === "whatsapp" ? "WhatsApp" : "SMS"}:{" "}
                      {state.allowed
                        ? "a receipt would be sent with the approved template."
                        : state.explanation}
                    </p>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold text-slate-900">Approved templates</h2>
        <p className="text-xs text-slate-600">
          The queue only sends with a template marked approved. A draft or rejected template
          blocks delivery rather than falling back to free text.
        </p>
        {view && view.templates.length > 0 ? (
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1">Channel</th>
                <th className="py-1">Purpose</th>
                <th className="py-1">Name</th>
                <th className="py-1">Language</th>
                <th className="py-1">State</th>
              </tr>
            </thead>
            <tbody>
              {view.templates.map((template) => (
                <tr key={template.id} className="border-t border-slate-100">
                  <td className="py-1">{template.channel === "sms" ? "SMS" : "WhatsApp"}</td>
                  <td className="py-1">{PURPOSE_LABELS[template.purpose]}</td>
                  <td className="py-1 font-mono">{template.name}</td>
                  <td className="py-1">{template.language}</td>
                  <td className="py-1">{STATUS_LABELS[template.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-slate-500">No template registered yet.</p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-medium text-slate-600">
            Channel
            <select
              value={templateChannel}
              onChange={(event) =>
                setTemplateChannel(event.target.value as MessagingChannel)
              }
              className="input mt-1 w-full"
            >
              <option value="whatsapp">WhatsApp</option>
              <option value="sms">SMS</option>
            </select>
          </label>
          <label className="block text-xs font-medium text-slate-600">
            Purpose
            <select
              value={templatePurpose}
              onChange={(event) =>
                setTemplatePurpose(event.target.value as MessagingPurpose)
              }
              className="input mt-1 w-full"
            >
              {Object.entries(PURPOSE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-slate-600">
            Template name
            <input
              value={templateKey}
              onChange={(event) => setTemplateKey(event.target.value)}
              className="input mt-1 w-full font-mono"
            />
          </label>
          <label className="block text-xs font-medium text-slate-600">
            Template language
            <input
              value={templateLanguage}
              onChange={(event) => setTemplateLanguage(event.target.value)}
              className="input mt-1 w-full"
            />
          </label>
          <label className="block text-xs font-medium text-slate-600">
            Provider approval
            <select
              value={templateStatus}
              onChange={(event) =>
                setTemplateStatus(
                  event.target.value as "draft" | "approved" | "rejected"
                )
              }
              className="input mt-1 w-full"
            >
              <option value="draft">Draft</option>
              <option value="approved">Approved by provider</option>
              <option value="rejected">Rejected</option>
            </select>
          </label>
        </div>
        <button
          type="button"
          onClick={() => void saveTemplate()}
          disabled={busy}
          className="btn btn-secondary btn-sm"
        >
          {busy ? "Saving…" : "Save template"}
        </button>
      </section>
    </div>
  );
}
