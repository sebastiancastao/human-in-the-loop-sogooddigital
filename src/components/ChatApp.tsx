"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import type { Conversation, ConversationResult, Message } from "@/types/chat";
import { canonicalizeCompanyUrl } from "@/lib/company";
import { Sidebar } from "./Sidebar";
import { ChatArea } from "./ChatArea";
import { MenuIcon } from "./Icons";

function ellipsize(value: string, max = 40): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 3).trimEnd()}...`;
}

function toPersistableConversation(conv: Conversation): Omit<Conversation, "results"> {
  const { id, title, messages, createdAt, type, company, socialEntry, context } = conv;
  return { id, title, messages, createdAt, type, company, socialEntry, context };
}

type SaveConversationResult =
  | { ok: true }
  | { ok: false; status?: number; details: string };

export function ChatApp() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const conversationsRef = useRef<Conversation[]>([]);

  const activeConversation = conversations.find((c) => c.id === activeConversationId) ?? null;

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  const saveConversation = useCallback(async (conv: Conversation): Promise<SaveConversationResult> => {
    try {
      const res = await fetch("/api/sogood_rag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toPersistableConversation(conv)),
      });
      if (!res.ok) {
        const details = await res.text().catch(() => "");
        console.error("Failed to save conversation", {
          id: conv.id,
          status: res.status,
          details: details.slice(0, 500),
        });
        return { ok: false, status: res.status, details: details.slice(0, 2000) };
      }
      return { ok: true };
    } catch (e) {
      console.error("Failed to save conversation", e);
      return {
        ok: false,
        details: e instanceof Error ? e.message : "Unknown save error",
      };
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
        conversationsRef.current = loaded;
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
    setConversations((prev) => {
      const next = [newConv, ...prev];
      conversationsRef.current = next;
      return next;
    });
    setActiveConversationId(newConv.id);
    // Don't persist until we have the social entry (first user message).
  }, []);

  const openResultSubchat = useCallback(
    (result: ConversationResult) => {
      const socialEntry = (result.socialEntry ?? result.content).trim();
      if (!socialEntry) return;

      const existing = conversationsRef.current.find(
        (c) => c.socialEntry?.trim() === socialEntry
      );
      if (existing) {
        setActiveConversationId(existing.id);
        return;
      }

      const titleBase =
        result.title?.trim() ||
        socialEntry.split(/\r?\n/, 1)[0]?.trim() ||
        "Subchat";
      const now = Date.now();
      const subchat: Conversation = {
        id: crypto.randomUUID(),
        title: ellipsize(titleBase),
        messages: [
          {
            id: crypto.randomUUID(),
            role: "system",
            content: socialEntry,
            timestamp: now,
          },
        ],
        createdAt: now,
        type: "results",
        socialEntry,
      };

      setConversations((prev) => {
        const next = [subchat, ...prev];
        conversationsRef.current = next;
        return next;
      });
      setActiveConversationId(subchat.id);
      void saveConversation(subchat);
    },
    [saveConversation]
  );

  const deleteConversation = useCallback((id: string) => {
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      conversationsRef.current = next;
      return next;
    });
    setActiveConversationId((prevActive) => (prevActive === id ? null : prevActive));
    void deleteConversationRemote(id);
  }, [deleteConversationRemote]);

  const sendMessage = useCallback(
    (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;

      let targetId = activeConversationId;
      let wasNewConversation = false;
      let currentConversations = conversationsRef.current;
      let activeConv =
        targetId ? currentConversations.find((c) => c.id === targetId) ?? null : null;

      // Detect first message: no active conversation, or active one is empty.
      const isFirstMessage = !targetId || (activeConv != null && activeConv.messages.length === 0);

      if (isFirstMessage) {
        // Reuse an existing conversation for the same company.
        const targetCompany = canonicalizeCompanyUrl(trimmed);
        const existing = currentConversations.find((c) => {
          if (c.id === targetId) return false;

          const cCompany = c.company ?? canonicalizeCompanyUrl(c.socialEntry);

          if (targetCompany && cCompany) return targetCompany === cCompany;
          return (c.socialEntry?.trim() ?? "") === trimmed;
        });

        if (existing) {
          // Drop empty placeholder (from New Chat) if present.
          if (targetId && activeConv && activeConv.messages.length === 0) {
            setConversations((prev) => {
              const next = prev.filter((c) => c.id !== targetId);
              conversationsRef.current = next;
              return next;
            });
            currentConversations = currentConversations.filter((c) => c.id !== targetId);
          }

          targetId = existing.id;
          activeConv = existing;
          setActiveConversationId(targetId);
        } else if (!targetId) {
          const newConv: Conversation = {
            id: crypto.randomUUID(),
            title: trimmed.slice(0, 30) + (trimmed.length > 30 ? "..." : ""),
            messages: [],
            createdAt: Date.now(),
            type: "results",
          };

          setConversations((prev) => {
            const next = [newConv, ...prev];
            conversationsRef.current = next;
            return next;
          });
          currentConversations = [newConv, ...currentConversations];
          targetId = newConv.id;
          activeConv = newConv;
          setActiveConversationId(targetId);
          wasNewConversation = true;
        } else {
          wasNewConversation = true;
        }
      }

      if (!targetId) return;
      const targetConversation =
        activeConv ?? currentConversations.find((c) => c.id === targetId) ?? null;
      if (!targetConversation) return;

      const message: Message = {
        id: crypto.randomUUID(),
        role: wasNewConversation ? "system" : "user",
        content: trimmed,
        timestamp: Date.now(),
      };

      const hasTitle =
        typeof targetConversation.title === "string" &&
        targetConversation.title.trim().length > 0;
      const updatedTitle =
        targetConversation.messages.length === 0 || !hasTitle
          ? trimmed.slice(0, 30) + (trimmed.length > 30 ? "..." : "")
          : targetConversation.title;

      const updatedAfterUser: Conversation = {
        ...targetConversation,
        type: targetConversation.type ?? "results",
        socialEntry:
          targetConversation.socialEntry ??
          (targetConversation.messages.length === 0 ? trimmed : undefined),
        title: updatedTitle,
        messages: [...targetConversation.messages, message],
      };

      setConversations((prev) => {
        const next = prev.map((c) => (c.id === targetId ? updatedAfterUser : c));
        conversationsRef.current = next;
        return next;
      });
      const capturedTargetId = targetId;
      const allMessages = updatedAfterUser.messages;

      setIsLoading(true);
      (async () => {
        try {
          // Ensure the latest turn is persisted before calling /api/chat.
          const saveBeforeChat = await saveConversation(updatedAfterUser);
          if (!saveBeforeChat.ok) {
            console.error("Chat aborted: pre-chat save failed", saveBeforeChat);
            return;
          }

          const requestBody = {
            conversationId: capturedTargetId,
            messages: allMessages.map((m) => ({
              role: m.role === "system" ? "user" : m.role,
              content: m.content,
            })),
          };

          const callChat = async () =>
            fetch("/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(requestBody),
            });

          let res = await callChat();

          // If the row wasn't visible yet, retry once after a short delay.
          if (res.status === 404) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            res = await callChat();
          }

          const raw = await res.text();
          let data: { reply?: string; error?: string } = {};
          try {
            data = raw ? (JSON.parse(raw) as { reply?: string; error?: string }) : {};
          } catch {
            data = {};
          }

          if (!res.ok) {
            console.error("Chat API error", {
              status: res.status,
              statusText: res.statusText,
              data,
              raw: raw.slice(0, 500),
            });
            return;
          }

          if (!data.reply || !data.reply.trim()) {
            console.error("Chat API returned empty reply", {
              status: res.status,
              data,
              raw: raw.slice(0, 500),
            });
            return;
          }

          const assistantMessage: Message = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: data.reply,
            timestamp: Date.now(),
          };

          let updatedAfterAssistant: Conversation | undefined;
          setConversations((prev) => {
            const next = prev.map((c) => {
              if (c.id !== capturedTargetId) return c;
              const updated = { ...c, messages: [...c.messages, assistantMessage] };
              updatedAfterAssistant = updated;
              return updated;
            });
            conversationsRef.current = next;
            return next;
          });

          if (updatedAfterAssistant) {
            const saveAfterChat = await saveConversation(updatedAfterAssistant);
            if (!saveAfterChat.ok) {
              console.error("Post-chat save failed", saveAfterChat);
            }
          }
        } catch (e) {
          console.error("Failed to get assistant response", e);
        } finally {
          setIsLoading(false);
        }
      })();
    },
    [activeConversationId, saveConversation]
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
          onOpenResultSubchat={openResultSubchat}
          isLoading={isLoading}
        />
      </div>
    </div>
  );
}
