export interface Message {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  // For Supabase persistence in `sogood_rag` (optional for UI-only state).
  type?: string;
  socialEntry?: string;
  context?: string;
}
