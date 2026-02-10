export interface Message {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface ConversationResult {
  id: string;
  title: string | null;
  content: string;
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  // For Supabase persistence in `sogood_rag` (optional for UI-only state).
  type?: string;
  company?: string;
  socialEntry?: string;
  context?: string;
  // Extra "results" rows for the same company; rendered in the UI but not persisted in the chat messages.
  results?: ConversationResult[];
}
