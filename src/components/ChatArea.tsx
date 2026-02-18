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

export function ChatArea({
  conversation,
  onSendMessage,
  onOpenResultSubchat,
  isLoading,
}: ChatAreaProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [resultsOpen, setResultsOpen] = useState(true);

  const results = useMemo(() => {
    const items = conversation?.results ?? [];
    return Array.isArray(items) ? items : [];
  }, [conversation?.results]);

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
