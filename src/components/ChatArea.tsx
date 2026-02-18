"use client";

import { useRef, useEffect, useMemo, useState } from "react";
import type { Conversation, ConversationResult } from "@/types/chat";
import { MessageBubble } from "./MessageBubble";
import { ChatInput } from "./ChatInput";

interface ChatAreaProps {
  conversation: Conversation | null;
  onSendMessage: (content: string) => void;
  onOpenResultSubchat?: (result: ConversationResult) => void;
  isLoading?: boolean;
}

type ExportRow = {
  title: string;
  content: string;
};

type ExportSection = {
  title: string;
  rows: ExportRow[];
};

export function ChatArea({
  conversation,
  onSendMessage,
  onOpenResultSubchat,
  isLoading,
}: ChatAreaProps) {
  const showContextExport = false;
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [resultsOpen, setResultsOpen] = useState(true);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  const results = useMemo(() => {
    const items = conversation?.results ?? [];
    return Array.isArray(items) ? items : [];
  }, [conversation?.results]);

  const resultRows = useMemo(
    () =>
      results
        .map((r, i) => ({
          title: r.title?.trim() || `Result ${i + 1}`,
          content: r.content.trim(),
        }))
        .filter((r) => r.content.length > 0),
    [results]
  );

  const messageRows = useMemo(
    () =>
      (conversation?.messages ?? [])
        .map((m, i) => ({
          title: `${m.role[0].toUpperCase()}${m.role.slice(1)} Message ${i + 1}`,
          content: m.content.trim(),
        }))
        .filter((r) => r.content.length > 0),
    [conversation?.messages]
  );

  function copyTextLegacy(text: string): boolean {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      ta.style.pointerEvents = "none";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function buildPayload(args: {
    title: string;
    header: string;
    sections: ExportSection[];
    warning?: string;
  }): string {
    const lines: string[] = [];
    lines.push(args.title || "SoGood Export");
    lines.push("");
    lines.push(args.header);
    lines.push("");

    args.sections.forEach((section) => {
      if (section.rows.length === 0) return;
      lines.push(section.title);
      lines.push("");
      section.rows.forEach((row, i) => {
        lines.push(`${i + 1}. ${row.title}`);
        lines.push(row.content);
        lines.push("");
      });
    });

    if (args.warning) {
      lines.push("Warnings");
      lines.push("");
      lines.push(args.warning);
      lines.push("");
    }

    return lines.join("\n").trim();
  }

  async function fetchContextRows(convId: string): Promise<{
    rows: ExportRow[];
    warning: string | null;
  }> {
    let rows: ExportRow[] = [];
    let warning: string | null = null;
    try {
      const contextRes = await fetch(
        `/api/sogood_rag/${encodeURIComponent(convId)}/contexts?debug=1`,
        {
          cache: "no-store",
        }
      );
      const contextData = (await contextRes.json().catch(() => ({}))) as {
        contexts?: { title?: string | null; content?: string | null }[];
        debug?: unknown;
        error?: string;
      };

      if (contextData.debug) {
        console.info("[context-export-debug]", contextData.debug);
      }
      if (!contextRes.ok) {
        throw new Error(
          contextData.error
            ? `context lookup failed (${contextRes.status}): ${contextData.error}`
            : `context lookup failed (${contextRes.status})`
        );
      }

      const rawRows = Array.isArray(contextData.contexts) ? contextData.contexts : [];
      rows = rawRows
        .map((row, i) => ({
          title: (row.title ?? "").trim() || `Context ${i + 1}`,
          content: (row.content ?? "").trim(),
        }))
        .filter((row) => row.content.length > 0);
      if (rows.length === 0) {
        warning = "No context rows matched. Open browser console and check [context-export-debug].";
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown error";
      warning = `Context rows could not be loaded: ${reason}`;
      console.error("Context export fetch failed", err);
    }
    return { rows, warning };
  }

  async function pushToGoogleDoc(args: {
    docTitle: string;
    payload: string;
    totalRows: number;
    warning?: string | null;
  }) {
    const warningLabel = args.warning ? " with warning" : "";
    setExportStatus(`Creating Google Doc${warningLabel}...`);
    const pendingWindow = window.open("", "_blank", "noopener,noreferrer");

    try {
      const res = await fetch("/api/export/google-doc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: args.docTitle,
          content: args.payload,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        url?: string;
      };
      if (!res.ok || !data.url) {
        throw new Error(data.error || "Google export API failed");
      }

      if (pendingWindow) {
        pendingWindow.location.replace(data.url);
      } else {
        window.open(data.url, "_blank", "noopener,noreferrer");
      }
      setExportStatus(`Exported ${args.totalRows} item(s) to Google Doc${warningLabel}.`);
      return;
    } catch (err) {
      if (pendingWindow) pendingWindow.close();
      const reason = err instanceof Error ? err.message : "unknown error";
      console.error("Google Doc export failed", err);
      setExportStatus(`Direct Google API export failed (${reason}). Using manual fallback...`);
    }

    let copied = false;
    try {
      await navigator.clipboard.writeText(args.payload);
      copied = true;
    } catch {
      copied = copyTextLegacy(args.payload);
    }
    const docWindow = window.open("https://docs.new", "_blank", "noopener,noreferrer");
    if (copied) {
      if (docWindow) {
        setExportStatus(
          `Google Doc opened. Press Ctrl+V (Cmd+V on Mac) to paste ${args.payload.length} characters from ${args.totalRows} item(s).`
        );
      } else {
        setExportStatus(
          `Copied ${args.payload.length} characters from ${args.totalRows} item(s). Popup blocked, open docs.new and paste.`
        );
      }
      return;
    }
    if (docWindow) {
      setExportStatus(
        "Google Doc opened but clipboard was blocked. Please allow clipboard permissions, then export again."
      );
    } else {
      setExportStatus(
        "Google export failed and popup/clipboard were blocked. Allow popups + clipboard and try again."
      );
    }
  }

  async function exportResultsAndMessages() {
    if (!conversation) return;
    const totalRows = resultRows.length + messageRows.length;
    if (totalRows === 0) {
      setExportStatus("No results or messages found to export.");
      return;
    }

    const payload = buildPayload({
      title: conversation.title || "SoGood Export",
      header: "Results + Messages Export",
      sections: [
        { title: "Results", rows: resultRows },
        { title: "Messages", rows: messageRows },
      ],
    });

    await pushToGoogleDoc({
      docTitle: `${conversation.title || "SoGood Export"} - Results + Messages`,
      payload,
      totalRows,
    });
  }

  async function exportContextOnly() {
    if (!conversation) return;

    const { rows: contextRows, warning } = await fetchContextRows(conversation.id);
    const parentContext = conversation.context?.trim();
    const parentContextRows: ExportRow[] = parentContext
      ? [{ title: "Conversation Context", content: parentContext }]
      : [];
    const totalRows = contextRows.length + parentContextRows.length;

    if (totalRows === 0) {
      setExportStatus("No context found to export.");
      return;
    }

    const payload = buildPayload({
      title: conversation.title || "SoGood Export",
      header: "Context-Only Export",
      sections: [
        { title: "Context Rows", rows: contextRows },
        { title: "Conversation Context", rows: parentContextRows },
      ],
      warning: warning ?? undefined,
    });

    await pushToGoogleDoc({
      docTitle: `${conversation.title || "SoGood Export"} - Context`,
      payload,
      totalRows,
      warning,
    });
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversation?.messages]);

  if (!conversation || conversation.messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8">
        <div className="text-center max-w-md">
          <h2 className="text-2xl font-semibold text-foreground mb-2">
            SoGood Chat
          </h2>
          <p className="text-muted text-sm mb-6">
            Start a conversation by typing a message below.
          </p>
        </div>
        <div className="w-full max-w-2xl mt-auto">
          <ChatInput onSend={onSendMessage} disabled={isLoading} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
          <div className="rounded-2xl border border-border bg-surface px-4 py-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm text-foreground">Export options</div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void exportResultsAndMessages()}
                  className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-hover transition-colors"
                >
                  Export Results + Messages
                </button>
                {showContextExport && (
                  <button
                    type="button"
                    onClick={() => void exportContextOnly()}
                    className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-hover transition-colors"
                  >
                    Export Context
                  </button>
                )}
              </div>
            </div>
            <div className="mt-2 text-xs text-muted">
              Results rows: {resultRows.length}. Messages: {messageRows.length}.
            </div>
            {exportStatus && (
              <div className="mt-2 text-xs text-muted">{exportStatus}</div>
            )}
          </div>

          {results.length > 0 && (
            <div className="rounded-2xl border border-border bg-surface px-4 py-3">
              <button
                type="button"
                onClick={() => setResultsOpen((v) => !v)}
                className="w-full flex items-center justify-between text-left"
              >
                <div className="text-sm font-medium text-foreground">
                  Results ({results.length})
                </div>
                <div className="text-xs text-muted">
                  {resultsOpen ? "Hide" : "Show"}
                </div>
              </button>

              {resultsOpen && (
                <div className="mt-3 space-y-2">
                  {results.map((r) => (
                    <button
                      type="button"
                      key={r.id}
                      onClick={() => onOpenResultSubchat?.(r)}
                      className="w-full text-left rounded-xl border border-border bg-background px-3 py-2 hover:bg-surface-hover transition-colors"
                    >
                      {r.title?.trim() && (
                        <div className="text-xs font-medium text-foreground/90 mb-1 truncate">
                          {r.title}
                        </div>
                      )}
                      <div className="text-xs whitespace-pre-wrap break-words text-foreground/80 max-h-44 overflow-y-auto scrollbar-thin pr-1">
                        {r.content}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {conversation.messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-assistant-bubble rounded-2xl rounded-bl-sm px-4 py-3">
                <div className="flex gap-1">
                  <span className="w-2 h-2 rounded-full bg-muted animate-bounce [animation-delay:0ms]" />
                  <span className="w-2 h-2 rounded-full bg-muted animate-bounce [animation-delay:150ms]" />
                  <span className="w-2 h-2 rounded-full bg-muted animate-bounce [animation-delay:300ms]" />
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="shrink-0 border-t border-border p-4">
        <div className="max-w-2xl mx-auto">
          <ChatInput onSend={onSendMessage} disabled={isLoading} />
        </div>
      </div>
    </div>
  );
}
