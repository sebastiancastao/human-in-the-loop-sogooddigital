"use client";

import { useEffect, useState, useCallback } from "react";
import type { Conversation, Message } from "@/types/chat";
import { canonicalizeCompanyUrl } from "@/lib/company";
import { Sidebar } from "./Sidebar";
import { ChatArea } from "./ChatArea";
import { MenuIcon } from "./Icons";

export function ChatApp() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isLoading, setIsLoading] = useState(false);

  const activeConversation = conversations.find((c) => c.id === activeConversationId) ?? null;

  const saveConversation = useCallback(async (conv: Conversation) => {
    try {
      await fetch("/api/sogood_rag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(conv),
      });
    } catch (e) {
      console.error("Failed to save conversation", e);
    }
  }, []);

  const deleteConversationRemote = useCallback(async (id: string) => {
    try {
      await fetch(`/api/sogood_rag/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } catch (e) {
      console.error("Failed to delete conversation", e);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/sogood_rag", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { conversations?: Conversation[] };
        if (cancelled) return;
        const loaded = Array.isArray(data.conversations) ? data.conversations : [];
        setConversations(loaded);
        setActiveConversationId((prev) => prev ?? loaded[0]?.id ?? null);
      } catch (e) {
        console.error("Failed to load conversations", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const createNewChat = useCallback(() => {
    const newConv: Conversation = {
      id: crypto.randomUUID(),
      title: "New Chat",
      messages: [],
      createdAt: Date.now(),
      type: "results",
    };
    setConversations((prev) => [newConv, ...prev]);
    setActiveConversationId(newConv.id);
    // Don't persist until we have the "social entry" (first user message).
  }, []);

  const deleteConversation = useCallback((id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    setActiveConversationId((prevActive) => (prevActive === id ? null : prevActive));
    void deleteConversationRemote(id);
  }, [deleteConversationRemote]);

  const sendMessage = useCallback(
    (content: string) => {
      if (!content.trim()) return;

      let targetId = activeConversationId;
      let wasNewConversation = false;
      const trimmed = content.trim();

      // Detect "first message" — either no active conversation, or the active one is still empty.
      const activeConv = targetId ? conversations.find((c) => c.id === targetId) : null;
      const isFirstMessage = !targetId || (activeConv != null && activeConv.messages.length === 0);

      if (isFirstMessage) {
        // Reuse an existing conversation for the same company (one conversation per company).
        const targetCompany = canonicalizeCompanyUrl(trimmed);
        const existing = conversations.find((c) => {
          if (c.id === targetId) return false;

          const cCompany =
            c.company ?? canonicalizeCompanyUrl(c.socialEntry);

          // If both are URLs, match by canonical company URL.
          if (targetCompany && cCompany) return targetCompany === cCompany;

          // Otherwise fall back to exact social-entry matching (non-URL queries).
          return (c.socialEntry?.trim() ?? "") === trimmed;
        });

        if (existing) {
          // Drop the empty placeholder (from "New Chat") if one was created.
          if (targetId && activeConv && activeConv.messages.length === 0) {
            setConversations((prev) => prev.filter((c) => c.id !== targetId));
          }
          targetId = existing.id;
          setActiveConversationId(targetId);
          // Not new — the message will be added as a regular "user" message.
        } else if (!targetId) {
          // No existing conversation and no placeholder — create one.
          const newConv: Conversation = {
            id: crypto.randomUUID(),
            title: trimmed.slice(0, 30) + (trimmed.length > 30 ? "..." : ""),
            messages: [],
            createdAt: Date.now(),
            type: "results",
          };
          setConversations((prev) => [newConv, ...prev]);
          targetId = newConv.id;
          setActiveConversationId(targetId);
          wasNewConversation = true;
        } else {
          // Empty placeholder from createNewChat — treat as new.
          wasNewConversation = true;
        }
      }

      // First message of a results conversation is the social entry => store as a system message.
      const message: Message = {
        id: crypto.randomUUID(),
        role: wasNewConversation ? "system" : "user",
        content: trimmed,
        timestamp: Date.now(),
      };

      let updatedAfterUser: Conversation | undefined;
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== targetId) return c;
          const updatedTitle =
            c.messages.length === 0
              ? content.slice(0, 30) + (content.length > 30 ? "..." : "")
              : c.title;
          const next: Conversation = {
            ...c,
            type: c.type ?? "results",
            // Conversation starter is the "social entry" (first user message).
            socialEntry: c.socialEntry ?? (c.messages.length === 0 ? content.trim() : undefined),
            title: updatedTitle,
            messages: [...c.messages, message],
          };
          updatedAfterUser = next;
          return next;
        })
      );
      if (updatedAfterUser) void saveConversation(updatedAfterUser);

      // Call the /api/chat route — this fetches both results + context for the company.
      // On the first message (system/social entry) the model sees the results data and responds.
      const capturedTargetId = targetId;
      setIsLoading(true);
      (async () => {
        try {
          // Gather current messages (including the one we just added).
          const current = conversations.find((c) => c.id === capturedTargetId);
          const allMessages = [
            ...(current?.messages ?? []),
            message,
          ];

          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              conversationId: capturedTargetId,
              // Map "system" messages to "user" so Anthropic always has a valid user turn.
              messages: allMessages.map((m) => ({
                role: m.role === "system" ? "user" : m.role,
                content: m.content,
              })),
            }),
          });

          const data = await res.json();
          if (!res.ok) {
            console.error("Chat API error", data);
            return;
          }

          const assistantMessage: Message = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: data.reply,
            timestamp: Date.now(),
          };

          let updatedAfterAssistant: Conversation | undefined;
          setConversations((prev) =>
            prev.map((c) => {
              if (c.id !== capturedTargetId) return c;
              const next = { ...c, messages: [...c.messages, assistantMessage] };
              updatedAfterAssistant = next;
              return next;
            })
          );
          if (updatedAfterAssistant) void saveConversation(updatedAfterAssistant);
        } catch (e) {
          console.error("Failed to get assistant response", e);
        } finally {
          setIsLoading(false);
        }
      })();
    },
    [activeConversationId, conversations, saveConversation]
  );

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground font-sans">
      <Sidebar
        conversations={conversations}
        activeConversationId={activeConversationId}
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen((prev) => !prev)}
        onNewChat={createNewChat}
        onSelectConversation={setActiveConversationId}
        onDeleteConversation={deleteConversation}
      />

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div className="flex flex-1 flex-col min-w-0">
        <header className="flex items-center h-12 px-4 border-b border-border shrink-0">
          <button
            onClick={() => setSidebarOpen((prev) => !prev)}
            className="mr-3 p-1.5 rounded hover:bg-surface-hover text-muted hover:text-foreground transition-colors"
          >
            <MenuIcon className="w-5 h-5" />
          </button>
          <h1 className="text-sm font-medium text-muted truncate">
            {activeConversation?.title ?? "SoGood Chat"}
          </h1>
        </header>

        <ChatArea
          conversation={activeConversation}
          onSendMessage={sendMessage}
          isLoading={isLoading}
        />
      </div>
    </div>
  );
}
