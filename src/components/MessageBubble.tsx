"use client";

import type { Message } from "@/types/chat";

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  return (
    <div
      className={`flex ${
        isSystem ? "justify-center" : isUser ? "justify-end" : "justify-start"
      }`}
    >
      <div
        className={`
          max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed
          ${isSystem
            ? "bg-surface text-muted border border-border rounded-xl"
            : isUser
              ? "bg-user-bubble text-white rounded-br-sm"
              : "bg-assistant-bubble text-foreground rounded-bl-sm"
          }
        `}
      >
        {message.content.split("\n").map((line, i, arr) => (
          <span key={i}>
            {line}
            {i < arr.length - 1 && <br />}
          </span>
        ))}
      </div>
    </div>
  );
}
