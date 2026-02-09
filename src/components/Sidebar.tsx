"use client";

import { useMemo, useState } from "react";
import type { Conversation } from "@/types/chat";
import {
  PlusIcon,
  ChatBubbleIcon,
  TrashIcon,
  CloseIcon,
  ContextIcon,
} from "./Icons";

interface SidebarProps {
  conversations: Conversation[];
  activeConversationId: string | null;
  isOpen: boolean;
  onToggle: () => void;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
}

export function Sidebar({
  conversations,
  activeConversationId,
  isOpen,
  onToggle,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
}: SidebarProps) {
  const [contextConversationId, setContextConversationId] = useState<string | null>(
    null
  );
  const [contextsByConversationId, setContextsByConversationId] = useState<
    Record<
      string,
      { id: string; title: string | null; content: string; createdAt: number }[]
    >
  >({});
  const [contextLoadingId, setContextLoadingId] = useState<string | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);

  const contextConversation = useMemo(() => {
    if (!contextConversationId) return null;
    return conversations.find((c) => c.id === contextConversationId) ?? null;
  }, [contextConversationId, conversations]);

  const contextRows = contextConversationId
    ? (contextsByConversationId[contextConversationId] ?? null)
    : null;

  async function openContext(id: string) {
    setContextConversationId(id);
    setContextError(null);

    if (contextsByConversationId[id]) return;

    setContextLoadingId(id);
    try {
      const res = await fetch(`/api/sogood_rag/${encodeURIComponent(id)}/contexts`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        contexts?: { id: string; title: string | null; content: string; createdAt: number }[];
      };
      const contexts = Array.isArray(data.contexts) ? data.contexts : [];
      setContextsByConversationId((prev) => ({ ...prev, [id]: contexts }));
    } catch (e) {
      setContextError(e instanceof Error ? e.message : "Failed to load context");
    } finally {
      setContextLoadingId((prev) => (prev === id ? null : prev));
    }
  }

  return (
    <aside
      className={`
        fixed inset-y-0 left-0 z-30 w-[260px] flex flex-col
        bg-sidebar-bg border-r border-border
        transform transition-transform duration-200 ease-in-out
        ${isOpen ? "translate-x-0" : "-translate-x-full"}
        md:relative md:translate-x-0
        ${isOpen ? "md:w-[260px]" : "md:w-0 md:border-r-0 md:overflow-hidden"}
      `}
    >
      <div className="flex items-center justify-between p-3 border-b border-border shrink-0">
        <button
          onClick={onNewChat}
          className="flex items-center gap-2 flex-1 px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-surface-hover transition-colors"
        >
          <PlusIcon className="w-4 h-4" />
          New Chat
        </button>
        <button
          onClick={onToggle}
          className="p-1.5 ml-2 rounded hover:bg-surface-hover text-muted md:hidden"
        >
          <CloseIcon className="w-4 h-4" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-1">
        {conversations.map((conv) => (
          <div
            key={conv.id}
            onClick={() => onSelectConversation(conv.id)}
            className={`
              group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer
              text-sm truncate transition-colors
              ${conv.id === activeConversationId
                ? "bg-surface text-foreground"
                : "text-muted hover:bg-surface-hover hover:text-foreground"
              }
            `}
          >
            <ChatBubbleIcon className="w-4 h-4 shrink-0" />
            <span className="truncate flex-1">{conv.title}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (contextConversationId === conv.id) {
                  setContextConversationId(null);
                  return;
                }
                void openContext(conv.id);
              }}
              title="Context"
              className={`
                opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-border transition-all
                text-muted hover:text-foreground
              `}
            >
              <ContextIcon className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDeleteConversation(conv.id);
                setContextConversationId((prev) => (prev === conv.id ? null : prev));
              }}
              className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-border text-muted hover:text-foreground transition-all"
            >
              <TrashIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </nav>

      {contextConversation && (
        <div className="shrink-0 border-t border-border p-3">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-foreground truncate">
              Context
            </div>
            <button
              onClick={() => setContextConversationId(null)}
              className="p-1 rounded hover:bg-surface-hover text-muted hover:text-foreground transition-colors"
              aria-label="Close context"
              title="Close"
            >
              <CloseIcon className="w-4 h-4" />
            </button>
          </div>

          <div className="mt-2 text-xs">
            {contextLoadingId === contextConversationId && (
              <div className="text-muted">Loading...</div>
            )}
            {contextError && (
              <div className="text-muted break-words">Error: {contextError}</div>
            )}
            {contextRows && contextRows.length === 0 && !contextLoadingId && !contextError && (
              <div className="text-muted">No context rows</div>
            )}
            {contextRows && contextRows.length > 0 && (
              <div className="max-h-44 overflow-y-auto scrollbar-thin pr-1 space-y-2">
                {contextRows.map((r) => (
                  <div
                    key={r.id}
                    className="rounded-lg border border-border bg-surface px-2 py-1.5"
                  >
                    {r.title?.trim() && (
                      <div className="text-foreground/90 font-medium mb-1 truncate">
                        {r.title}
                      </div>
                    )}
                    <div className="whitespace-pre-wrap break-words text-foreground/80">
                      {r.content}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
