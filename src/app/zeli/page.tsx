"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  BarChart3,
  Check,
  Copy,
  MessageSquarePlus,
  Pencil,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
} from "lucide-react";
import {
  createZeliConversation,
  deleteZeliConversation,
  getZeliBootstrap,
  getZeliConversation,
  listZeliConversations,
  renameZeliConversation,
  setZeliFeedback,
} from "@/lib/actions/zeli.actions";
import { acceptZeliTeamDisclosure } from "@/lib/actions/zeli-team.actions";
import { AppBrand } from "@/components/brand/AppBrand";
import Modal, { ConfirmDialog } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";

interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
}

interface Message {
  id: string;
  role: string;
  content: string;
  sources: Array<{ label: string; href?: string; detail?: string }>;
  feedback: string | null;
  provider?: string | null;
  model?: string | null;
  deterministic?: boolean;
}

export default function ZeliPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<{
    provider: string;
    model: string;
    available: boolean;
    reason?: string;
    message?: string;
    external?: { state: string; allowed: boolean };
    conversation?: {
      mode: "local" | "external";
      state: string;
      message: string;
      provider?: string | null;
      model?: string | null;
      teamTesting?: boolean;
      teamTesterActive?: boolean;
      teamDisclosureAccepted?: boolean;
      teamDisclosureVersion?: string;
    };
  } | null>(null);
  const [acceptingDisclosure, setAcceptingDisclosure] = useState(false);
  const [showAgreement, setShowAgreement] = useState(false);
  const [agreementChecked, setAgreementChecked] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Conversation | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const toast = useToast();
  const [environment, setEnvironment] = useState<"staging" | "production">("production");
  const [acceptanceMode, setAcceptanceMode] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [analyticsAccess, setAnalyticsAccess] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadConversation = useCallback(async (id: string) => {
    const result = await getZeliConversation(id);
    if (result.success) {
      setSelected(id);
      setMessages(result.data.messages as Message[]);
    }
  }, []);

  const boot = useCallback(async () => {
    const [bootstrap, list] = await Promise.all([
      getZeliBootstrap(),
      listZeliConversations(),
    ]);
    if (bootstrap.success && bootstrap.data) {
      setStatus(bootstrap.data.status);
      setSuggestions(bootstrap.data.suggestions);
      setAnalyticsAccess(Boolean(bootstrap.data.analyticsAccess));
      setEnvironment(bootstrap.data.environment ?? "production");
      setAcceptanceMode(Boolean(bootstrap.data.acceptanceMode));
    }
    if (list.success && list.data && list.data.length > 0) {
      setConversations(list.data);
      await loadConversation(list.data[0].id);
    } else {
      const created = await createZeliConversation();
      if (created.success && created.data) {
        setConversations([
          { id: created.data.id, title: created.data.title, updatedAt: new Date().toISOString() },
        ]);
        setSelected(created.data.id);
        setMessages([]);
      } else {
        setError(created.error ?? "Could not start a conversation.");
      }
    }
  }, [loadConversation]);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending]);

  async function refreshConversations() {
    const list = await listZeliConversations();
    if (list.success && list.data) setConversations(list.data);
  }

  async function newConversation() {
    const created = await createZeliConversation();
    if (!created.success || !created.data) {
      setError(created.error ?? "Could not start a conversation.");
      return;
    }
    await refreshConversations();
    setSelected(created.data.id);
    setMessages([]);
    setError("");
  }

  async function acceptDisclosure(): Promise<boolean> {
    setAcceptingDisclosure(true);
    setError("");
    try {
      const result = await acceptZeliTeamDisclosure();
      if (!result.success) {
        setError(result.error ?? "The disclosure could not be accepted.");
        return false;
      }
      setStatus((current) =>
        current
          ? {
              ...current,
              conversation: current.conversation
                ? { ...current.conversation, teamDisclosureAccepted: true }
                : current.conversation,
            }
          : current
      );
      toast.push("success", "Zeli Usage Agreement accepted.");
      return true;
    } catch {
      setError("The agreement could not be accepted. Please try again.");
      return false;
    } finally {
      setAcceptingDisclosure(false);
    }
  }

  async function handleAcceptAgreement() {
    if (!agreementChecked || acceptingDisclosure) return;
    const accepted = await acceptDisclosure();
    if (accepted) {
      setShowAgreement(false);
      setAgreementChecked(false);
    }
  }

  async function submitRename() {
    if (!renameTarget || dialogBusy) return;
    const title = renameValue.trim();
    if (!title) {
      setError("Enter a conversation title.");
      return;
    }
    setDialogBusy(true);
    try {
      const result = await renameZeliConversation(renameTarget.id, title);
      if (result.success) {
        await refreshConversations();
        toast.push("success", "Conversation renamed.");
        setRenameTarget(null);
      } else {
        setError(result.error ?? "Could not rename the conversation.");
      }
    } catch {
      setError("Could not rename the conversation. Please try again.");
    } finally {
      setDialogBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget || dialogBusy) return;
    setDialogBusy(true);
    try {
      const result = await deleteZeliConversation(deleteTarget.id);
      if (!result.success) {
        setError(result.error ?? "Could not delete the conversation.");
        return;
      }
      const remaining = conversations.filter((item) => item.id !== deleteTarget.id);
      setConversations(remaining);
      toast.push("success", "Conversation deleted.");
      if (selected === deleteTarget.id) {
        if (remaining[0]) await loadConversation(remaining[0].id);
        else await newConversation();
      }
      setDeleteTarget(null);
    } catch {
      setError("Could not delete the conversation. Please try again.");
    } finally {
      setDialogBusy(false);
    }
  }

  async function send(message: string) {
    if (!selected || sending) return;
    if (
      status?.conversation?.teamTesting &&
      !status.conversation.teamDisclosureAccepted
    ) {
      setError(
        "Accept the Team Testing disclosure before sending a message to DeepSeek."
      );
      return;
    }
    const question = message.trim();
    if (!question) return;
    setSending(true);
    setError("");
    setInput("");
    const controller = new AbortController();
    abortRef.current = controller;

    const localUser: Message = {
      id: `local-user-${Date.now()}`,
      role: "user",
      content: question,
      sources: [],
      feedback: null,
    };
    const localAssistant: Message = {
      id: `local-assistant-${Date.now()}`,
      role: "assistant",
      content: "",
      sources: [],
      feedback: null,
    };
    setMessages((current) => [...current, localUser, localAssistant]);

    try {
      const response = await fetch("/api/zeli/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: selected, message: question }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Zeli could not answer. Please try again.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        const snapshot = text;
        setMessages((current) =>
          current.map((item) =>
            item.id === localAssistant.id ? { ...item, content: snapshot } : item
          )
        );
      }
      // Reload authoritative persisted history (real message ids and sources).
      await loadConversation(selected);
      await refreshConversations();
    } catch (caught) {
      if ((caught as Error).name === "AbortError") {
        setMessages((current) =>
          current.map((item) =>
            item.id === localAssistant.id
              ? { ...item, content: item.content || "Generation stopped." }
              : item
          )
        );
      } else {
        setError((caught as Error).message);
        setMessages((current) =>
          current.filter((item) => item.id !== localAssistant.id)
        );
      }
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  async function copy(message: Message) {
    await navigator.clipboard.writeText(message.content);
    setCopied(message.id);
    setTimeout(() => setCopied(null), 1500);
  }

  async function feedback(message: Message, value: "helpful" | "unhelpful") {
    const result = await setZeliFeedback(
      message.id,
      message.feedback === value ? null : value
    );
    if (result.success) {
      setMessages((current) =>
        current.map((item) =>
          item.id === message.id
            ? { ...item, feedback: item.feedback === value ? null : value }
            : item
        )
      );
    }
  }

  function openRename(conversation: Conversation) {
    setRenameTarget(conversation);
    setRenameValue(conversation.title);
  }

  function openDelete(conversation: Conversation) {
    setDeleteTarget(conversation);
  }

  return (
    <div className="min-h-screen bg-[#F6F5EC] text-[#17211C]">
      <header className="sticky top-0 z-40 border-b border-brand-100 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <Link href="/workspace" className="text-brand-700 hover:text-brand-900" aria-label="Back to workspace">
              <ArrowLeft size={18} aria-hidden />
            </Link>
            <AppBrand markSize={28} href="/workspace" />
            <span className="hidden items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-800 sm:inline-flex">
              <Sparkles size={13} aria-hidden /> Zeli
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`rounded-full px-2.5 py-1 font-medium ${
                status?.available
                  ? "bg-emerald-50 text-emerald-800"
                  : "bg-amber-50 text-amber-800"
              }`}
              title={status?.reason}
            >
              {status?.conversation?.teamTesting
                ? `Team Testing · ${status.conversation.model ?? "DeepSeek"}`
                : status?.available
                  ? `Provider: ${status.provider}`
                  : "External provider disabled"}
            </span>
            {analyticsAccess && (
              <Link href="/admin/zeli-analytics" className="btn btn-secondary btn-sm">
                <BarChart3 size={14} aria-hidden /> Analytics
              </Link>
            )}
            <button type="button" onClick={newConversation} className="btn btn-primary btn-sm">
              <MessageSquarePlus size={14} aria-hidden /> New
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 pt-3">
        {status?.conversation?.teamTesting ? (
          <div className="rounded-xl border border-indigo-300 bg-indigo-50 px-3 py-2 text-xs text-indigo-950">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1 font-semibold">
                <Sparkles size={14} aria-hidden /> TEAM TESTING — LIVE DEEPSEEK API
              </span>
              <span>Provider: {status.conversation.provider ?? "deepseek"}</span>
              <span>Model: {status.conversation.model ?? "configured model"}</span>
              <span>Data: synthetic business fixtures only</span>
            </div>
            <p className="mt-1 font-medium text-amber-900">
              Messages in this mode are processed by DeepSeek. Use fictional business,
              customer and payment examples only. Do not enter real customer names,
              telephone numbers, account details, balances or transaction records.
            </p>
            {!status.conversation.teamDisclosureAccepted && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-2 py-2 text-amber-950">
                <span>
                  Accept the external-AI disclosure (version{" "}
                  {status.conversation.teamDisclosureVersion ?? "team"}) before your
                  first DeepSeek conversation.
                </span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => setShowAgreement(true)}
                >
                  Read and accept agreement
                </button>
              </div>
            )}
          </div>
        ) : acceptanceMode ? (
          <div className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-950">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1 font-semibold">
                <Sparkles size={14} aria-hidden /> Enhanced AI — TEAM ACCEPTANCE MODE
              </span>
              <span>Provider: {status?.conversation?.provider ?? "deepseek"}</span>
              <span>Model: {status?.conversation?.model ?? "configured model"}</span>
              <span>Environment: {environment}</span>
            </div>
            <p className="mt-1 font-medium text-amber-900">
              TEAM TEST ENVIRONMENT — Use dummy business data and fictional
              conversations only. Do not enter real customer, employee, payment or
              confidential business information.
            </p>
            <p className="mt-1">
              Business figures come from this staging database and are calculated by
              MaaCash. Enhanced AI explains them; it cannot change records. If an
              answer is labelled “Local mode — Enhanced AI unavailable or blocked”, the
              provider was unavailable and Zeli answered locally.
            </p>
          </div>
        ) : (
          <div className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-xs ${
            status?.conversation?.mode === "external"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border-amber-200 bg-amber-50 text-amber-900"
          }`}>
            <ShieldCheck size={15} className="mt-0.5 flex-none" aria-hidden />
            <p>
              <strong>
                {status?.conversation?.mode === "external"
                  ? "External AI conversation is enabled."
                  : "Local mode."}
              </strong>{" "}
              {status?.conversation?.mode === "external"
                ? "An approved external provider may help with greetings and general conversation. It never receives business records or figures; every financial answer is calculated inside MaaCash."
                : "Zeli runs entirely inside MaaCash. Your messages are not sent to an external AI. Financial answers are calculated from your authorized records."}
            </p>
          </div>
        )}
      </div>

      <div className="mx-auto grid max-w-7xl gap-4 px-4 py-4 lg:grid-cols-[280px_1fr]">
        <aside className="hidden lg:block" aria-label="Conversations">
          <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Conversations
          </h2>
          <ul className="mt-2 space-y-1">
            {conversations.map((conversation) => (
              <li key={conversation.id} className="group flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => loadConversation(conversation.id)}
                  className={`min-w-0 flex-1 rounded-lg px-3 py-2 text-left text-sm ${
                    selected === conversation.id
                      ? "bg-white font-semibold text-brand-900 shadow-sm"
                      : "text-slate-700 hover:bg-white/70"
                  }`}
                >
                  <span className="block truncate">{conversation.title}</span>
                </button>
                <button
                  type="button"
                  onClick={() => openRename(conversation)}
                  className="rounded p-1 text-slate-400 hover:text-brand-700"
                  aria-label={`Rename ${conversation.title}`}
                >
                  <Pencil size={13} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => openDelete(conversation)}
                  className="rounded p-1 text-slate-400 hover:text-red-700"
                  aria-label={`Delete ${conversation.title}`}
                >
                  <Trash2 size={13} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div className="lg:hidden">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500" htmlFor="zeli-conversation-mobile">
            Conversation
          </label>
          <div className="mt-1 flex gap-2">
            <select
              id="zeli-conversation-mobile"
              className="min-w-0 flex-1"
              value={selected ?? ""}
              onChange={(event) => loadConversation(event.target.value)}
            >
              {conversations.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>
                  {conversation.title}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                const current = conversations.find((item) => item.id === selected);
                if (current) openDelete(current);
              }}
              className="btn btn-secondary btn-sm"
              aria-label="Delete current conversation"
              disabled={!selected}
            >
              <Trash2 size={14} aria-hidden />
            </button>
          </div>
        </div>

        <main className="flex min-h-[70vh] flex-col rounded-2xl border border-brand-100 bg-white shadow-sm">
          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6" aria-live="polite">
            {messages.length === 0 && (
              <div className="mx-auto max-w-xl py-10 text-center">
                <Sparkles className="mx-auto text-brand-600" size={30} aria-hidden />
                <h1 className="mt-3 text-xl font-semibold text-brand-900">
                  Ask Zeli about your business
                </h1>
                <p className="mt-2 text-sm text-slate-600">
                  Answers use your authorized records. Zeli cannot post or reverse money.
                </p>
                <div className="mt-5 grid gap-2 text-left">
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => send(suggestion)}
                      className="rounded-xl border border-brand-100 bg-brand-50/50 px-3 py-2 text-sm text-brand-900 hover:border-brand-300"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message) => (
              <article
                key={message.id}
                className={`max-w-[95%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  message.role === "user"
                    ? "ml-auto bg-brand-800 text-white"
                    : "bg-[#F6F5EC] text-[#17211C]"
                }`}
              >
                <div className="whitespace-pre-wrap">
                  {message.content ||
                    (sending && message.role === "assistant"
                      ? "Reading authorized records…"
                      : "")}
                </div>
                {message.role === "assistant" && message.content && (
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                    <button type="button" onClick={() => copy(message)} className="inline-flex items-center gap-1 hover:text-brand-800">
                      {copied === message.id ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                      {copied === message.id ? "Copied" : "Copy"}
                    </button>
                    <button
                      type="button"
                      onClick={() => feedback(message, "helpful")}
                      className={`inline-flex items-center gap-1 ${message.feedback === "helpful" ? "text-emerald-700" : "hover:text-brand-800"}`}
                      aria-label="Helpful"
                    >
                      <ThumbsUp size={12} aria-hidden /> Helpful
                    </button>
                    <button
                      type="button"
                      onClick={() => feedback(message, "unhelpful")}
                      className={`inline-flex items-center gap-1 ${message.feedback === "unhelpful" ? "text-red-700" : "hover:text-brand-800"}`}
                      aria-label="Not helpful"
                    >
                      <ThumbsDown size={12} aria-hidden /> Not helpful
                    </button>
                    {message.role === "assistant" &&
                      message.deterministic &&
                      !(environment === "staging" && status?.conversation?.mode === "external") && (
                        <span className="inline-flex items-center gap-1 text-slate-500" title="Computed from MaaCash records by the internal rule-based engine">
                          <ShieldCheck size={12} aria-hidden /> Computed from your records
                        </span>
                      )}
                    {message.role === "assistant" && message.provider === "deepseek-team-testing" && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 font-medium text-indigo-900"
                        title="Genuine DeepSeek API response. Synthetic business data only; no live records were sent."
                      >
                        <Sparkles size={12} aria-hidden /> Team Testing · live DeepSeek
                      </span>
                    )}
                    {message.role === "assistant" &&
                      message.provider?.startsWith("deepseek") &&
                      message.provider !== "deepseek-team-testing" && (
                        <span className="inline-flex items-center gap-1 text-slate-500" title="Answered by an approved external provider. No business records or figures were sent.">
                          <Sparkles size={12} aria-hidden /> External AI answer
                        </span>
                      )}
                    {message.role === "assistant" &&
                      environment === "staging" &&
                      status?.conversation?.mode === "external" &&
                      message.provider === "internal" && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-900"
                          title="The external provider was unavailable or blocked this turn. Zeli answered locally."
                        >
                          <ShieldCheck size={12} aria-hidden /> Local mode — Enhanced AI
                          unavailable or blocked
                        </span>
                      )}
                    {message.sources?.length > 0 && (
                      <span className="text-slate-400">Sources:</span>
                    )}
                    {message.sources?.map((source) =>
                      source.href ? (
                        <Link key={source.label} href={source.href} className="underline underline-offset-2 hover:text-brand-800">
                          {source.label}
                        </Link>
                      ) : (
                        <span key={source.label}>{source.label}</span>
                      )
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>

          {error && (
            <div className="mx-4 mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
              {error}
            </div>
          )}

          <form
            className="border-t border-brand-100 p-3 sm:p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void send(input);
            }}
          >
            <label htmlFor="zeli-input" className="sr-only">
              Ask Zeli
            </label>
            <div className="flex items-end gap-2">
              <textarea
                id="zeli-input"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                rows={2}
                maxLength={4000}
                placeholder="Ask about customers, contributions, remittances or today's daily accounts…"
                className="min-h-[48px] flex-1 resize-y"
                disabled={
                  sending ||
                  Boolean(
                    status?.conversation?.teamTesting &&
                      !status.conversation.teamDisclosureAccepted
                  )
                }
              />
              {sending ? (
                <button type="button" onClick={stop} className="btn btn-secondary" aria-label="Stop generation">
                  <Square size={14} aria-hidden /> Stop
                </button>
              ) : (
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={
                    !input.trim() ||
                    Boolean(
                      status?.conversation?.teamTesting &&
                        !status.conversation.teamDisclosureAccepted
                    )
                  }
                >
                  <Send size={15} aria-hidden /> Send
                </button>
              )}
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Zeli reads only records you are authorized to see. It cannot post, reverse or approve transactions. External AI is optional and never authoritative.
            </p>
          </form>
        </main>
      </div>

      <Modal
        open={showAgreement}
        onClose={() => {
          if (!acceptingDisclosure) {
            setShowAgreement(false);
            setAgreementChecked(false);
          }
        }}
        title="Zeli Usage Agreement"
        description="Read the agreement before using Zeli with an external AI provider."
        size="lg"
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setShowAgreement(false);
                setAgreementChecked(false);
              }}
              disabled={acceptingDisclosure}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleAcceptAgreement}
              disabled={!agreementChecked || acceptingDisclosure}
              aria-busy={acceptingDisclosure}
            >
              {acceptingDisclosure ? "Saving acceptance…" : "Accept and Continue"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-950">
            <p className="font-semibold">Team Testing — external AI</p>
            <p className="mt-1">
              Messages sent in this mode may be processed by the approved external
              provider. Use fictional business, customer and payment examples only.
            </p>
          </div>
          <ul className="list-disc space-y-2 pl-5 text-sm text-slate-700">
            <li>Do not enter real customer names, phone numbers, account numbers, balances or transaction records.</li>
            <li>Zeli can explain business figures, but it cannot create, approve, reverse or delete records.</li>
            <li>Financial answers are calculated inside MaaCash; the external provider is never authoritative.</li>
            <li>You may stop using Zeli at any time. Acceptance is recorded against your account.</li>
          </ul>
          <p className="text-xs text-slate-500">
            Disclosure version {status?.conversation?.teamDisclosureVersion ?? "team"}.
            Accepting means you understand these conditions and agree to use only
            synthetic data in this mode.
          </p>
          <label className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm font-medium text-slate-800">
            <input
              type="checkbox"
              className="mt-1"
              checked={agreementChecked}
              onChange={(event) => setAgreementChecked(event.target.checked)}
            />
            <span>I have read and accept the Zeli Usage Agreement.</span>
          </label>
          {error && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
              {error}
            </p>
          )}
        </div>
      </Modal>

      <Modal
        open={Boolean(renameTarget)}
        onClose={() => {
          if (!dialogBusy) setRenameTarget(null);
        }}
        title="Rename conversation"
        description="Give this conversation a short, recognisable title."
        size="sm"
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setRenameTarget(null)}
              disabled={dialogBusy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={submitRename}
              disabled={dialogBusy || !renameValue.trim()}
              aria-busy={dialogBusy}
            >
              {dialogBusy ? "Saving…" : "Save title"}
            </button>
          </>
        }
      >
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Conversation title</span>
          <input
            type="text"
            className="mt-1 w-full"
            maxLength={120}
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            autoFocus
          />
        </label>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => {
          if (!dialogBusy) setDeleteTarget(null);
        }}
        onConfirm={confirmDelete}
        title="Delete this conversation?"
        description="This conversation and its messages will be permanently removed. This cannot be undone."
        confirmLabel="Delete conversation"
        tone="danger"
        loading={dialogBusy}
      />
    </div>
  );
}
