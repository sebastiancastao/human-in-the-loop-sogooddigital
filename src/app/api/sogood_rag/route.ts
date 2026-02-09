import { NextResponse } from "next/server";
import type { Conversation, Message } from "@/types/chat";
import { supabaseRestServer } from "@/lib/supabase/restServer";

type SogoodRagRow = {
  id: string;
  company: string | null;
  type: string | null;
  social_entry: string | null;
  context: string | null;
  title: string;
  messages: Message[] | null;
  created_at: string;
};

export async function GET() {
  const rows = await supabaseRestServer<SogoodRagRow[]>("/sogood_rag", {
    query: {
      // Only show "results" conversations by default.
      type: "eq.results",
      select: "id,company,type,social_entry,context,title,messages,created_at",
      order: "created_at.desc",
    },
  });

  const conversations: Conversation[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    messages: normalizeMessages({
      conversationId: r.id,
      createdAt: new Date(r.created_at).getTime(),
      socialEntry: r.social_entry ?? undefined,
      messages: ((r.messages ?? []) as Message[]) ?? [],
    }),
    createdAt: new Date(r.created_at).getTime(),
    type: r.type ?? "results",
    socialEntry: r.social_entry ?? undefined,
    // Context now lives in separate rows (type='context'); keep this only if you still write to the column.
    context: r.context ?? undefined,
  }));

  return NextResponse.json({ conversations });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Conversation | null;
  if (!body?.id || !body.title || !Array.isArray(body.messages)) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const type = body.type ?? "results";
  const firstSystem =
    body.messages.find((m) => m.role === "system")?.content ?? null;
  const firstUser = body.messages.find((m) => m.role === "user")?.content ?? null;
  const socialEntry = body.socialEntry ?? firstSystem ?? firstUser;
  const company = normalizeCompanyUrl(socialEntry);
  const normalizedMessages = normalizeMessages({
    conversationId: body.id,
    createdAt: body.createdAt || Date.now(),
    socialEntry: socialEntry ?? undefined,
    messages: body.messages,
  });

  const row = {
    id: body.id,
    // In this project `company` is a *text* URL identifying the company.
    // If the conversation starter is a URL, persist it here for linking context rows.
    company,
    type,
    social_entry: socialEntry,
    context: body.context ?? null,
    title: body.title,
    messages: normalizedMessages,
    created_at: new Date(body.createdAt || Date.now()).toISOString(),
  };

  const saved = await supabaseRestServer<SogoodRagRow[]>("/sogood_rag", {
    method: "POST",
    query: { on_conflict: "id" },
    prefer: "resolution=merge-duplicates,return=representation",
    body: row,
  });

  const savedRow = saved?.[0] ?? null;
  if (!savedRow) {
    return NextResponse.json({ error: "Upsert failed" }, { status: 502 });
  }

  const conversation: Conversation = {
    id: savedRow.id,
    title: savedRow.title,
    messages: normalizeMessages({
      conversationId: savedRow.id,
      createdAt: new Date(savedRow.created_at).getTime(),
      socialEntry: savedRow.social_entry ?? undefined,
      messages: (savedRow.messages ?? []) as Message[],
    }),
    createdAt: new Date(savedRow.created_at).getTime(),
    type: savedRow.type ?? "results",
    socialEntry: savedRow.social_entry ?? undefined,
    context: savedRow.context ?? undefined,
  };

  return NextResponse.json({ conversation });
}

function normalizeMessages(args: {
  conversationId: string;
  createdAt: number;
  socialEntry?: string;
  messages: Message[];
}): Message[] {
  const social = args.socialEntry?.trim();
  const msgs = Array.isArray(args.messages) ? [...args.messages] : [];
  if (!social) return msgs;

  const hasSystemSocial = msgs.some(
    (m) => m.role === "system" && m.content.trim() === social
  );
  if (hasSystemSocial) return msgs;

  // If the first message equals social entry but is a user message, promote it to system.
  const first = msgs[0];
  if (first && first.content.trim() === social && first.role !== "assistant") {
    msgs[0] = { ...first, role: "system" };
    return msgs;
  }

  // Otherwise prepend a synthetic system message.
  return [
    {
      id: `system:${args.conversationId}:social_entry`,
      role: "system",
      content: social,
      timestamp: args.createdAt,
    },
    ...msgs,
  ];
}

function normalizeCompanyUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  // Keep it strict to avoid accidentally storing random text as "company".
  if (/^https?:\/\/\S+/i.test(v)) return v;
  return null;
}
