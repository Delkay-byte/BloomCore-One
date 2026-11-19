"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  BarChart3,
  Check,
  Copy,
  Loader2,
  MessageSquarePlus,
  Send,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from "lucide-react";
import {
  createZeliConversation,
  deleteZeliConversation,
  getZeliBootstrap,
  getZeliConversation,
  listZeliConversations,
  renameZeliConversation,
  searchZeliConversations,
  sendZeliMessage,
  setZeliFeedback,
} from "@/lib/actions/zeli.actions";
import BloomCoreAttribution from "@/components/brand/BloomCoreAttribution";
import ZeliAnswerView from "@/components/zeli/ZeliAnswerView";

interface Message {
  id: string;
  role: string;
  content: string;
  sources?: { label?: string; href?: string }[];
  sections?: unknown;
  answerMeta?: unknown;
  feedback?: string | null;
  createdAt?: string;
}

interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  createdAt?: string;
}

interface HistoryResult extends ConversationSummary {
  snippet: string | null;
}

interface Usage {
  used: number;
  limit: number;
  remaining: number;
  periodLabel: string;
  resetAt: string;
  blocked: null | { code: string; message: string };
}

const dateLabel = (value?: string | null) =>
  value
    ? new Date(value).toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

/** Zeli — read-only business assistant. */
export default function ZeliPage() {
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState("");
  const [error, setError] = useState("");
  const [role, setRole] = useState("admin");
  const [analyticsAccess, setAnalyticsAccess] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState("");
  const [lastQuestion, setLastQuestion] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyResults, setHistoryResults] = useState<HistoryResult[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; title: string } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const localIdRef = useRef(0);

  const loadConversation = useCallback(async (id: string) => {
    setLoadingThread(true);
    setError("");
    try {
      const result = await getZeliConversation(id);
      if (!result.success) {
        setError(result.error ?? "That conversation could not be opened.");
        return;
      }
      setSelected(result.data.id);
      setMessages(result.data.messages as Message[]);
      setShowHistory(false);
    } finally {
      setLoadingThread(false);
    }
  }, []);

  const newConversation = useCallback(async () => {
    const result = await createZeliConversation();
    if (!result.success || !result.data) {
      setError(result.error ?? "A new conversation could not be started.");
      return;
    }
    setConversations((current) => [
      { id: result.data!.id, title: result.data!.title, updatedAt: new Date().toISOString() },
      ...current,
    ]);
    setSelected(result.data.id);
    setMessages([]);
    setError("");
    setShowHistory(false);
    composerRef.current?.focus();
  }, []);

  useEffect(() => {
    (async () => {
      const boot = await getZeliBootstrap();
      if (!boot.success) {
        setFatal(boot.error ?? "Zeli is unavailable right now.");
        setReady(true);
        return;
      }
      setRole(boot.data!.role);
      setAnalyticsAccess(boot.data!.analyticsAccess);
      setSuggestions(boot.data!.suggestions);
      setUsage(boot.data!.usage as Usage | null);

      const list = await listZeliConversations();
      if (list.success && list.data) {
        setConversations(list.data);
        if (list.data[0]) await loadConversation(list.data[0].id);
        else await newConversation();
      }
      setReady(true);
    })();
  }, [loadConversation, newConversation]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  useEffect(() => {
    if (!historyOpen) return;
    let active = true;
    setHistoryBusy(true);
    setHistoryError("");
    const timer = setTimeout(() => {
      void searchZeliConversations(historyQuery)
        .then((result) => {
          if (!active) return;
          if (!result.success || !result.data) {
            setHistoryError(result.error ?? "History could not be loaded.");
            setHistoryResults([]);
          } else {
            setHistoryResults(result.data);
          }
        })
        .finally(() => {
          if (active) setHistoryBusy(false);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [historyOpen, historyQuery]);

  async function send(question: string) {
    const text = question.trim();
    if (!text || !selected || sending) return;
    if (usage?.blocked) {
      setError(usage.blocked.message);
      return;
    }
    setSending(true);
    setError("");
    setLastQuestion(text);
    setInput("");
    localIdRef.current += 1;
    const optimistic: Message = { id: `local-${localIdRef.current}`, role: "user", content: text };
    setMessages((current) => [...current, optimistic]);

    try {
      const result = await sendZeliMessage({ conversationId: selected, message: text });
      if (!result.success || !result.data) {
        setError(result.error ?? "Zeli could not answer that question.");
        return;
      }
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === selected && result.data!.title
            ? { ...conversation, title: result.data!.title, updatedAt: new Date().toISOString() }
            : conversation
        )
      );
      setMessages((current) => [
        ...current,
        {
          id: `answer-${localIdRef.current}`,
          role: "assistant",
          content: result.data!.text,
          sources: (result.data!.sources as Message["sources"]) ?? [],
          sections: result.data!.sections,
          answerMeta: result.data!.answerMeta,
          feedback: null,
        },
      ]);
      setLastQuestion(null);
    } catch {
      setError("Zeli could not answer that question. Please try again.");
    } finally {
      setSending(false);
      composerRef.current?.focus();
    }
  }

  async function copyMessage(message: Message) {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedId(message.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      setError("The answer could not be copied on this device.");
    }
  }

  async function rate(message: Message, value: "helpful" | "unhelpful") {
    const next = message.feedback === value ? null : value;
    setMessages((current) =>
      current.map((row) => (row.id === message.id ? { ...row, feedback: next } : row))
    );
    await setZeliFeedback(message.id, next).catch(() => undefined);
  }

  function openRename(id: string, title: string) {
    setRenameTarget({ id, title });
    setRenameValue(title);
  }

  async function rename(id: string, next: string) {
    setRenameTarget(null);
    const result = await renameZeliConversation(id, next);
    if (!result.success) {
      setError(result.error ?? "The conversation could not be renamed.");
      return;
    }
    setConversations((current) =>
      current.map((row) => (row.id === id ? { ...row, title: next.trim().slice(0, 80) } : row))
    );
  }

  async function remove(id: string) {
    setConfirmDelete(null);
    const result = await deleteZeliConversation(id);
    if (!result.success) {
      setError(result.error ?? "The conversation could not be deleted.");
      return;
    }
    const remaining = conversations.filter((row) => row.id !== id);
    setConversations(remaining);
    if (selected === id) {
      if (remaining[0]) await loadConversation(remaining[0].id);
      else await newConversation();
    }
  }

  if (!ready) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-16" aria-busy="true">
        <div className="h-8 w-40 animate-pulse rounded-md bg-slate-200" />
        <div className="mt-6 space-y-3">
          <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
          <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
          <div className="h-24 animate-pulse rounded-xl bg-slate-100" />
        </div>
      </div>
    );
  }

  if (fatal) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-16">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center">
          <Sparkles className="mx-auto text-brand-600" size={28} aria-hidden />
          <h1 className="mt-3 text-xl font-semibold text-slate-900">Zeli is paused</h1>
          <p className="mt-2 text-sm text-slate-600">{fatal}</p>
          <p className="mt-2 text-sm text-slate-600">
            Your MaaCash workspace, records and payments are unaffected.
          </p>
          <Link href="/admin/dashboard" className="btn btn-primary mt-5 inline-flex">
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-3 py-4 sm:px-6 sm:py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-900 sm:text-2xl">
            <Sparkles size={20} className="text-brand-600" aria-hidden /> Zeli
          </h1>
          <p className="mt-1 max-w-xl text-sm text-slate-600">
            Ask about your business. Zeli reads your authorised records and cannot
            post, reverse or delete money.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {analyticsAccess && (
            <Link href="/admin/zeli-analytics" className="btn btn-secondary btn-sm">
              <BarChart3 size={14} aria-hidden /> Analytics
            </Link>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              setHistoryOpen(true);
              setShowHistory(false);
            }}
            aria-haspopup="dialog"
            aria-expanded={historyOpen}
            aria-controls="zeli-history-dialog"
          >
            History
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={newConversation}>
            <MessageSquarePlus size={14} aria-hidden /> New
          </button>
        </div>
      </header>

      <div className="mt-4 grid gap-4 md:grid-cols-[16rem_1fr]">
        <aside
          id="zeli-history"
          className={`${showHistory ? "block" : "hidden"} md:block`}
          aria-label="Conversations"
        >
          <div className="rounded-xl border border-slate-200 bg-white p-2">
            {conversations.length === 0 ? (
              <p className="px-2 py-3 text-sm text-slate-600">No conversations yet.</p>
            ) : (
              <ul className="space-y-1">
                {conversations.map((conversation) => (
                  <li key={conversation.id}>
                    <div
                      className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 ${
                        selected === conversation.id ? "bg-brand-50" : "hover:bg-slate-50"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => loadConversation(conversation.id)}
                        className="min-w-0 flex-1 truncate text-left text-sm text-slate-800"
                        aria-current={selected === conversation.id ? "true" : undefined}
                        title={conversation.title}
                      >
                        {conversation.title}
                      </button>
                      <button
                        type="button"
                        onClick={() => openRename(conversation.id, conversation.title)}
                        className="rounded p-1 text-xs text-slate-500 hover:text-slate-800"
                        aria-label={`Rename ${conversation.title}`}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete({ id: conversation.id, title: conversation.title })}
                        className="rounded p-1 text-slate-500 hover:text-red-700"
                        aria-label={`Delete ${conversation.title}`}
                      >
                        <Trash2 size={13} aria-hidden />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {usage && (
            <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600">
              {usage.blocked ? (
                <p className="text-amber-800">{usage.blocked.message}</p>
              ) : (
                <>
                  <p className="font-medium text-slate-800">
                    {usage.used} of {usage.limit} requests this {usage.periodLabel.replace(/^this /, "")}
                  </p>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full rounded-full bg-brand-600"
                      style={{ width: `${Math.min(100, Math.round((usage.used / Math.max(1, usage.limit)) * 100))}%` }}
                    />
                  </div>
                  <p className="mt-1.5">
                    {usage.remaining} left · resets{" "}
                    {new Date(usage.resetAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}
                  </p>
                </>
              )}
            </div>
          )}
        </aside>

        <main className="flex min-h-[65vh] flex-col rounded-2xl border border-slate-200 bg-white">
          <div
            ref={scrollRef}
            className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6"
            aria-live="polite"
            aria-busy={loadingThread || sending}
          >
            {loadingThread ? (
              <div className="space-y-3" aria-hidden="true">
                <div className="h-14 w-3/4 animate-pulse rounded-2xl bg-slate-100" />
                <div className="ml-auto h-10 w-1/2 animate-pulse rounded-2xl bg-slate-100" />
              </div>
            ) : messages.length === 0 ? (
              <div className="mx-auto max-w-xl py-8 text-center">
                <Sparkles className="mx-auto text-brand-600" size={28} aria-hidden />
                <h2 className="mt-3 text-lg font-semibold text-slate-900">
                  What would you like to know?
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Answers are calculated from your MaaCash records for your role
                  {role === "admin" ? "" : ` (${role})`}. Zeli is read-only.
                </p>
                <div className="mt-5 grid gap-2 text-left">
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => send(suggestion)}
                      disabled={sending || Boolean(usage?.blocked)}
                      className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 hover:border-brand-300 disabled:opacity-60"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message) => {
                const assistant = message.role !== "user";
                return (
                  <article
                    key={message.id}
                    className={`max-w-[95%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                      assistant
                        ? "bg-slate-50 text-slate-900"
                        : "ml-auto bg-brand-700 text-white"
                    }`}
                  >
                    {assistant ? (
                      <ZeliAnswerView
                        content={message.content}
                        sections={message.sections}
                        answerMeta={message.answerMeta}
                      />
                    ) : (
                      <p className="whitespace-pre-wrap break-words">{message.content}</p>
                    )}

                    {assistant && Boolean(message.sources?.length) && (
                      <ul className="mt-2 space-y-1 border-t border-slate-200 pt-2 text-xs text-slate-600">
                        {message.sources!.slice(0, 5).map((source, index) => (
                          <li key={`${message.id}-src-${index}`}>
                            {source.href ? (
                              <Link href={source.href} className="underline">
                                {source.label ?? source.href}
                              </Link>
                            ) : (
                              source.label ?? "MaaCash records"
                            )}
                          </li>
                        ))}
                      </ul>
                    )}

                    {assistant && (
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                        {message.createdAt && <span>{dateLabel(message.createdAt)}</span>}
                        <button
                          type="button"
                          onClick={() => copyMessage(message)}
                          className="inline-flex items-center gap-1 hover:text-slate-800"
                        >
                          {copiedId === message.id ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                          {copiedId === message.id ? "Copied" : "Copy"}
                        </button>
                        <button
                          type="button"
                          onClick={() => rate(message, "helpful")}
                          className={`inline-flex items-center gap-1 hover:text-slate-800 ${
                            message.feedback === "helpful" ? "text-emerald-700" : ""
                          }`}
                          aria-pressed={message.feedback === "helpful"}
                        >
                          <ThumbsUp size={12} aria-hidden /> Helpful
                        </button>
                        <button
                          type="button"
                          onClick={() => rate(message, "unhelpful")}
                          className={`inline-flex items-center gap-1 hover:text-slate-800 ${
                            message.feedback === "unhelpful" ? "text-amber-700" : ""
                          }`}
                          aria-pressed={message.feedback === "unhelpful"}
                        >
                          <ThumbsDown size={12} aria-hidden /> Not helpful
                        </button>
                      </div>
                    )}
                  </article>
                );
              })
            )}

            {sending && (
              <div className="inline-flex items-center gap-2 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600" role="status">
                <Loader2 size={14} className="animate-spin" aria-hidden /> Working through your records…
              </div>
            )}
          </div>

          <div className="border-t border-slate-200 p-3 sm:p-4">
            {error && (
              <div role="alert" className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
                {error}
                {lastQuestion && (
                  <button
                    type="button"
                    className="ml-2 font-medium underline"
                    onClick={() => send(lastQuestion)}
                    disabled={sending}
                  >
                    Retry
                  </button>
                )}
              </div>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                send(input);
              }}
              className="flex items-end gap-2"
            >
              <label className="sr-only" htmlFor="zeli-input">
                Ask Zeli a question
              </label>
              <textarea
                id="zeli-input"
                ref={composerRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    send(input);
                  }
                }}
                rows={2}
                maxLength={4000}
                placeholder={usage?.blocked ? "Zeli is paused for this business." : "Ask about collections, balances, staff or reconciliations…"}
                className="input max-h-40 min-h-[2.75rem] flex-1 resize-y"
                disabled={sending || Boolean(usage?.blocked)}
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={sending || !input.trim() || Boolean(usage?.blocked)}
              >
                {sending ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Send size={15} aria-hidden />}
                <span className="sr-only">Send question</span>
              </button>
            </form>
            <p className="mt-1.5 text-xs text-slate-500">
              Zeli explains and summarises. It never posts, approves or reverses money.
            </p>
          </div>
        </main>
      </div>
      {historyOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setHistoryOpen(false);
          }}
        >
          <div
            id="zeli-history-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="zeli-history-title"
            className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl sm:p-5"
            onKeyDown={(event) => {
              if (event.key === "Escape") setHistoryOpen(false);
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="zeli-history-title" className="text-base font-semibold text-slate-900">
                  Conversation history
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Only your own conversations in this business are shown.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setHistoryOpen(false)}
              >
                Close
              </button>
            </div>

            <label className="mt-3 block text-xs font-medium text-slate-600">
              Search conversations
              <input
                type="search"
                value={historyQuery}
                onChange={(event) => setHistoryQuery(event.target.value)}
                placeholder="Search by title or message content"
                className="input mt-1 w-full"
                autoFocus
              />
            </label>

            <div className="mt-3 min-h-[10rem] flex-1 overflow-y-auto">
              {historyBusy ? (
                <p className="py-8 text-center text-sm text-slate-500" role="status">
                  Loading conversations…
                </p>
              ) : historyError ? (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                  {historyError}
                </p>
              ) : historyResults.length === 0 ? (
                <div className="py-8 text-center">
                  <p className="text-sm font-medium text-slate-700">
                    {historyQuery ? "No conversations match that search." : "No conversations yet."}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Start a new conversation from the Zeli page.
                  </p>
                </div>
              ) : (
                <ul className="space-y-1">
                  {historyResults.map((conversation) => (
                    <li key={conversation.id}>
                      <button
                        type="button"
                        onClick={() => {
                          void loadConversation(conversation.id);
                          setHistoryOpen(false);
                        }}
                        className={`w-full rounded-lg px-3 py-2 text-left ${
                          selected === conversation.id ? "bg-brand-50" : "hover:bg-slate-50"
                        }`}
                        aria-current={selected === conversation.id ? "true" : undefined}
                      >
                        <span className="block truncate text-sm font-medium text-slate-900">
                          {conversation.title}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-slate-500">
                          Last activity {dateLabel(conversation.updatedAt)}
                          {conversation.createdAt
                            ? ` · Created ${dateLabel(conversation.createdAt)}`
                            : ""}
                        </span>
                        {conversation.snippet && (
                          <span className="mt-0.5 block line-clamp-2 text-xs text-slate-600">
                            {conversation.snippet}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      <footer className="mt-6 border-t border-slate-200 pt-3 text-center">
        <BloomCoreAttribution />
      </footer>

      {renameTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setRenameTarget(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="zeli-rename-title"
            className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl"
            onKeyDown={(event) => {
              if (event.key === "Escape") setRenameTarget(null);
            }}
          >
            <h2 id="zeli-rename-title" className="text-base font-semibold text-slate-900">
              Rename conversation
            </h2>
            <label className="mt-3 block text-sm">
              <span className="text-slate-600">Conversation name</span>
              <input
                autoFocus
                value={renameValue}
                maxLength={80}
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    const next = renameValue.trim();
                    if (next) void rename(renameTarget.id, next);
                  }
                }}
                className="input mt-1 w-full"
              />
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setRenameTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!renameValue.trim()}
                onClick={() => void rename(renameTarget.id, renameValue.trim())}
              >
                Save name
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setConfirmDelete(null);
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="zeli-delete-title"
            aria-describedby="zeli-delete-body"
            className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl"
            onKeyDown={(event) => {
              if (event.key === "Escape") setConfirmDelete(null);
            }}
          >
            <h2 id="zeli-delete-title" className="text-base font-semibold text-slate-900">
              Delete this conversation?
            </h2>
            <p id="zeli-delete-body" className="mt-2 text-sm text-slate-600">
              &ldquo;{confirmDelete.title}&rdquo; and its messages will be removed. This cannot be
              undone.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                autoFocus
                className="btn btn-secondary"
                onClick={() => setConfirmDelete(null)}
              >
                Keep conversation
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void remove(confirmDelete.id)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
