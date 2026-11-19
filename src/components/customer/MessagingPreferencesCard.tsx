"use client";

import { useEffect, useState } from "react";
import Notice from "@/components/ui/Notice";
import {
  getMyMessagingPreference,
  saveMyMessagingPreference,
  type MessagingPreferenceView,
} from "@/lib/actions/customer-messaging.actions";

/**
 * Customer-controlled transactional receipt consent.
 *
 * WhatsApp is a separate number from SMS. Nothing is sent unless the customer
 * opts in here; opting out records a timestamp and immediately blocks new
 * receipts. Marketing is not part of this consent.
 */
export default function MessagingPreferencesCard() {
  const [pref, setPref] = useState<MessagingPreferenceView | null>(null);
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [whatsappOptIn, setWhatsappOptIn] = useState(false);
  const [smsNumber, setSmsNumber] = useState("");
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [preferred, setPreferred] = useState<"whatsapp" | "sms" | "none">("none");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    let active = true;
    void getMyMessagingPreference()
      .then((result) => {
        if (!active || !result.success || !result.data) return;
        setPref(result.data);
        setWhatsappNumber(result.data.whatsappNumber ?? "");
        setWhatsappOptIn(result.data.whatsappOptedIn);
        setSmsNumber(result.data.smsNumber ?? "");
        setSmsOptIn(result.data.smsOptedIn);
        setPreferred(result.data.preferredChannel ?? "none");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function save() {
    setSaving(true);
    setError("");
    setSuccess("");
    const result = await saveMyMessagingPreference({
      whatsappNumber,
      whatsappOptIn,
      smsNumber,
      smsOptIn,
      preferredChannel: preferred,
    });
    if (!result.success || !result.data) {
      setError(result.error ?? "Your receipt preferences could not be saved.");
    } else {
      setPref(result.data);
      setSuccess("Receipt preferences saved.");
    }
    setSaving(false);
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500">
        Loading receipt preferences…
      </div>
    );
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4" aria-labelledby="receipt-prefs-heading">
      <h2 id="receipt-prefs-heading" className="text-base font-semibold text-slate-900">
        Receipt messages
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Choose whether MaaCash may send a receipt after a confirmed contribution or
        withdrawal. These are transactional messages only, never marketing.
      </p>

      {error && <Notice type="error" className="mt-3">{error}</Notice>}
      {success && <Notice type="success" className="mt-3">{success}</Notice>}

      <div className="mt-4 space-y-4">
        <fieldset className="rounded-lg border border-slate-200 p-3">
          <legend className="px-1 text-sm font-medium text-slate-900">WhatsApp</legend>
          <p className="text-xs text-slate-500">
            Use a WhatsApp number that may be different from your ordinary phone.
          </p>
          <label className="mt-2 block text-xs font-medium text-slate-600">
            WhatsApp number
            <input
              type="tel"
              value={whatsappNumber}
              onChange={(event) => setWhatsappNumber(event.target.value)}
              placeholder="+233 20 000 0000"
              className="input mt-1 w-full"
              autoComplete="tel"
            />
          </label>
          <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={whatsappOptIn}
              onChange={(event) => {
                setWhatsappOptIn(event.target.checked);
                if (event.target.checked && preferred === "none") setPreferred("whatsapp");
              }}
              className="mt-0.5"
            />
            <span>
              I confirm this number is mine and I agree to receive WhatsApp receipts for
              confirmed transactions.
            </span>
          </label>
          {pref?.whatsappOptedIn && (
            <p className="mt-2 text-xs text-emerald-700">Currently opted in.</p>
          )}
          {!pref?.whatsappOptedIn && pref?.whatsappOptOutAt && (
            <p className="mt-2 text-xs text-slate-500">
              Opted out on {new Date(pref.whatsappOptOutAt).toLocaleDateString("en-GB")}.
            </p>
          )}
        </fieldset>

        <fieldset className="rounded-lg border border-slate-200 p-3">
          <legend className="px-1 text-sm font-medium text-slate-900">SMS</legend>
          <label className="block text-xs font-medium text-slate-600">
            SMS number
            <input
              type="tel"
              value={smsNumber}
              onChange={(event) => setSmsNumber(event.target.value)}
              placeholder="+233 20 000 0000"
              className="input mt-1 w-full"
              autoComplete="tel"
            />
          </label>
          <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={smsOptIn}
              onChange={(event) => {
                setSmsOptIn(event.target.checked);
                if (event.target.checked && preferred === "none") setPreferred("sms");
              }}
              className="mt-0.5"
            />
            <span>I agree to receive SMS receipts for confirmed transactions.</span>
          </label>
          {pref?.smsOptedIn && (
            <p className="mt-2 text-xs text-emerald-700">Currently opted in.</p>
          )}
          {!pref?.smsOptedIn && pref?.smsOptOutAt && (
            <p className="mt-2 text-xs text-slate-500">
              Opted out on {new Date(pref.smsOptOutAt).toLocaleDateString("en-GB")}.
            </p>
          )}
        </fieldset>

        <label className="block text-xs font-medium text-slate-600">
          Preferred receipt channel
          <select
            value={preferred}
            onChange={(event) =>
              setPreferred(event.target.value as "whatsapp" | "sms" | "none")
            }
            className="input mt-1 w-full"
          >
            <option value="none">No preference</option>
            <option value="whatsapp">WhatsApp first</option>
            <option value="sms">SMS first</option>
          </select>
        </label>

        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="btn btn-primary btn-sm"
        >
          {saving ? "Saving…" : "Save receipt preferences"}
        </button>
      </div>
    </section>
  );
}
