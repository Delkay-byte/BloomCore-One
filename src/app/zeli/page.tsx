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
import { AppBrand } from "@/components/brand/AppBrand";

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
    };
  } | null>(null);
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

  async function send(message: string) {
    if (!selected || sending) return;
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

  async function rename(conversation: Conversation) {
    const title = window.prompt("Rename conversation", conversation.title);
    if (!title) return;
    const result = await renameZeliConversation(conversation.id, title);
    if (result.success) await refreshConversations();
    else setError(result.error ?? "Could not rename the conversation.");
  }

  async function remove(conversation: Conversation) {
    if (!window.confirm("Delete this conversation permanently?")) return;
    const result = await deleteZeliConversation(conversation.id);
    if (!result.success) {
      setError(result.error ?? "Could not delete the conversation.");
      return;
    }
    const remaining = conversations.filter((item) => item.id !== conversation.id);
    setConversations(remaining);
    if (selected === conversation.id) {
      if (remaining[0]) await loadConversation(remaining[0].id);
      else await newConversation();
    }
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
              {status?.available
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
        {acceptanceMode ? (
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
                  onClick={() => rename(conversation)}
                  className="rounded p-1 text-slate-400 hover:text-brand-700"
                  aria-label={`Rename ${conversation.title}`}
                >
                  <Pencil size={13} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => remove(conversation)}
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
              onClick={() => selected && remove(conversations.find((item) => item.id === selected) ?? conversations[0])}
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
                    {message.role === "assistant" && message.provider?.startsWith("deepseek") && (
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
                disabled={sending}
              />
              {sending ? (
                <button type="button" onClick={stop} className="btn btn-secondary" aria-label="Stop generation">
                  <Square size={14} aria-hidden /> Stop
                </button>
              ) : (
                <button type="submit" className="btn btn-primary" disabled={!input.trim()}>
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
    </div>
  );
}
