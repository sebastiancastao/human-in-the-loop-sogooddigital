import { NextResponse } from "next/server";
import type { Conversation, Message } from "@/types/chat";
import { supabaseRestServer } from "@/lib/supabase/restServer";
import { canonicalizeCompanyUrl } from "@/lib/company";

type SogoodRagRow = {
  id: string;
  company: string | null;
  type: string | null;
  social_entry: string | null;
  context: string | null;
  title: string | null;
  messages: unknown;
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

  // Group by company so the UI sees one conversation per company.
  // (Some datasets also store company URLs with minor variations like trailing slashes or UTM params.)
  const byCompanyKey = new Map<string, SogoodRagRow[]>();
  const companyKeyForRow = (r: SogoodRagRow): string => {
    const canon =
      canonicalizeCompanyUrl(r.company) ??
      canonicalizeCompanyUrl(r.social_entry) ??
      null;
    if (canon) return `company:${canon}`;

    // Keep persisted chat threads distinct when no canonical company URL is available.
    const hasMessages = parseStoredMessages(r.messages).length > 0;
    if (hasMessages) return `chat:${r.id}`;

    return `title:${(r.title ?? "").trim().toLowerCase()}`;
  };

  for (const r of rows) {
    const k = companyKeyForRow(r);
    const arr = byCompanyKey.get(k);
    if (arr) arr.push(r);
    else byCompanyKey.set(k, [r]);
  }

  const groups = Array.from(byCompanyKey.values()).map((group) => {
    // Choose a "primary" row:
    // 1) prefer actual chat threads (rows with messages)
    // 2) prefer rows that have a usable company URL (for linking results/context)
    // 3) newest row wins ties
    const sorted = [...group].sort((a, b) => {
      const aMsgs = Array.isArray(a.messages) ? a.messages.length : 0;
      const bMsgs = Array.isArray(b.messages) ? b.messages.length : 0;
      if (aMsgs !== bMsgs) return bMsgs - aMsgs;

      const aCompany = canonicalizeCompanyUrl(a.company) ?? canonicalizeCompanyUrl(a.social_entry);
      const bCompany = canonicalizeCompanyUrl(b.company) ?? canonicalizeCompanyUrl(b.social_entry);
      if (Boolean(aCompany) !== Boolean(bCompany)) return aCompany ? -1 : 1;

      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    const primary = sorted[0];
    const latestAt = Math.max(...group.map((r) => new Date(r.created_at).getTime()));
    return { primary, latestAt, group };
  });

  // Sort groups by latest activity (so newly-ingested results bubble the company thread up)
  groups.sort((a, b) => b.latestAt - a.latestAt);

  const conversations: Conversation[] = groups.map(({ primary: r, group }) => {
    const createdAt = new Date(r.created_at).getTime();
    const company = canonicalizeCompanyUrl(r.company) ?? canonicalizeCompanyUrl(r.social_entry) ?? undefined;
    const normalizedPrimaryMessages = normalizeMessages({
      conversationId: r.id,
      createdAt,
      socialEntry: r.social_entry ?? undefined,
      messages: parseStoredMessages(r.messages),
    });

    // Build a separate "results" collection from sibling rows (exclude the primary chat thread).
    // Only include rows that look like ingested results (no chat messages, but have content).
    const results = group
      .filter((x) => x.id !== r.id)
      .filter((x) => parseStoredMessages(x.messages).length === 0)
      .map((x) => ({
        id: x.id,
        title: x.title ?? null,
        content: (x.context ?? x.social_entry ?? "").trim(),
        socialEntry: (x.social_entry ?? "").trim() || undefined,
        createdAt: new Date(x.created_at).getTime(),
      }))
      .filter((x) => x.content.length > 0)
      .sort((a, b) => a.createdAt - b.createdAt);

    return {
      id: r.id,
      title: resolveConversationTitle({
        id: r.id,
        title: r.title,
        socialEntry: r.social_entry,
        company: r.company,
        messages: normalizedPrimaryMessages,
      }),
      messages: normalizedPrimaryMessages,
      createdAt,
      type: r.type ?? "results",
      company,
      socialEntry: r.social_entry ?? undefined,
      // Context now lives in separate rows (type='context'); keep this only if you still write to the column.
      context: r.context ?? undefined,
      results,
    };
  });

  return NextResponse.json({ conversations });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as Partial<Conversation> | null;
    if (!body?.id || typeof body.id !== "string") {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const createdAt = normalizeCreatedAt(body.createdAt);
    const normalizedIncomingMessages = sanitizeMessages(body.messages, body.id, createdAt);
    const existingRows = await supabaseRestServer<SogoodRagRow[]>("/sogood_rag", {
      query: {
        select: "id,company,type,social_entry,context,title,messages,created_at",
        id: `eq.${body.id}`,
        limit: 1,
      },
    });
    const existing = existingRows?.[0] ?? null;
    const existingCreatedAt = existing ? new Date(existing.created_at).getTime() : createdAt;
    const normalizedExistingMessages = sanitizeMessages(
      parseStoredMessages(existing?.messages),
      body.id,
      existingCreatedAt
    );
    const mergedMessages = pickMostCompleteMessages(
      normalizedExistingMessages,
      normalizedIncomingMessages
    );
    const type = typeof body.type === "string" && body.type.trim() ? body.type : "results";
    const firstSystem =
      mergedMessages.find((m) => m.role === "system")?.content ?? null;
    const firstUser = mergedMessages.find((m) => m.role === "user")?.content ?? null;
    const socialEntry =
      (typeof body.socialEntry === "string" && body.socialEntry.trim()) ||
      (typeof existing?.social_entry === "string" && existing.social_entry.trim()) ||
      firstSystem ||
      firstUser ||
      null;
    const company =
      canonicalizeCompanyUrl(
        typeof body.company === "string" ? body.company : null
      ) ??
      canonicalizeCompanyUrl(existing?.company ?? null) ??
      canonicalizeCompanyUrl(socialEntry);
    const title = resolveConversationTitle({
      id: body.id,
      title:
        typeof body.title === "string" && body.title.trim().length > 0
          ? body.title
          : existing?.title ?? null,
      socialEntry,
      company,
      messages: mergedMessages,
    });
    const normalizedMessages = normalizeMessages({
      conversationId: body.id,
      createdAt: existingCreatedAt,
      socialEntry: socialEntry ?? undefined,
      messages: mergedMessages,
    });

    const row = {
      id: body.id,
      // In this project `company` is a *text* URL identifying the company.
      // If the conversation starter is a URL, persist it here for linking context rows.
      company,
      type,
      social_entry: socialEntry,
      context: body.context ?? existing?.context ?? null,
      title,
      messages: normalizedMessages,
      created_at: new Date(existingCreatedAt).toISOString(),
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
      messages: normalizeMessages({
        conversationId: savedRow.id,
        createdAt: new Date(savedRow.created_at).getTime(),
        socialEntry: savedRow.social_entry ?? undefined,
        messages: parseStoredMessages(savedRow.messages),
      }),
      title: resolveConversationTitle({
        id: savedRow.id,
        title: savedRow.title,
        socialEntry: savedRow.social_entry,
        company: savedRow.company,
        messages: parseStoredMessages(savedRow.messages),
      }),
      createdAt: new Date(savedRow.created_at).getTime(),
      type: savedRow.type ?? "results",
      company: canonicalizeCompanyUrl(savedRow.company) ?? canonicalizeCompanyUrl(savedRow.social_entry) ?? undefined,
      socialEntry: savedRow.social_entry ?? undefined,
      context: savedRow.context ?? undefined,
    };

    return NextResponse.json({ conversation });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to persist conversation" },
      { status: 500 }
    );
  }
}

function normalizeCreatedAt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function sanitizeMessages(
  value: unknown,
  conversationId: string,
  createdAt: number
): Message[] {
  if (!Array.isArray(value)) return [];

  const out: Message[] = [];
  for (const m of value) {
    if (!m || typeof m !== "object") continue;
    const role = "role" in m ? (m as { role?: unknown }).role : undefined;
    const content = "content" in m ? (m as { content?: unknown }).content : undefined;
    if (role !== "system" && role !== "user" && role !== "assistant") continue;
    const text = typeof content === "string" ? content : String(content ?? "");
    out.push({
      id:
        "id" in m && typeof (m as { id?: unknown }).id === "string" && (m as { id?: string }).id
          ? (m as { id: string }).id
          : `${role}:${conversationId}:${out.length}`,
      role,
      content: text,
      timestamp:
        "timestamp" in m &&
        typeof (m as { timestamp?: unknown }).timestamp === "number" &&
        Number.isFinite((m as { timestamp: number }).timestamp)
          ? (m as { timestamp: number }).timestamp
          : createdAt,
    });
  }

  return out;
}

function parseStoredMessages(value: unknown): Message[] {
  if (Array.isArray(value)) return sanitizeMessages(value, "stored", Date.now());
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return sanitizeMessages(parsed, "stored", Date.now());
      return [];
    } catch {
      return [];
    }
  }
  return [];
}

function pickMostCompleteMessages(existing: Message[], incoming: Message[]): Message[] {
  if (!Array.isArray(existing) || existing.length === 0) return incoming;
  if (!Array.isArray(incoming) || incoming.length === 0) return existing;

  if (incoming.length > existing.length) return incoming;
  if (existing.length > incoming.length) return existing;

  const existingLastTs = existing[existing.length - 1]?.timestamp ?? 0;
  const incomingLastTs = incoming[incoming.length - 1]?.timestamp ?? 0;
  return incomingLastTs >= existingLastTs ? incoming : existing;
}

function resolveConversationTitle(args: {
  id: string;
  title: string | null | undefined;
  socialEntry: string | null | undefined;
  company: string | null | undefined;
  messages: Message[];
}): string {
  const explicit = (args.title ?? "").trim();
  if (explicit) return explicit;

  const firstUser = args.messages.find((m) => m.role === "user")?.content?.trim();
  if (firstUser) return ellipsize(firstUser);

  const social = (args.socialEntry ?? "").trim();
  if (social) return ellipsize(firstLine(social));

  const company = canonicalizeCompanyUrl(args.company);
  if (company) {
    try {
      return new URL(company).hostname;
    } catch {
      return company;
    }
  }

  return `Chat ${args.id.slice(0, 8)}`;
}

function firstLine(value: string): string {
  const line = value.split(/\r?\n/, 1)[0] ?? value;
  return line.trim();
}

function ellipsize(value: string, max = 40): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 3).trimEnd()}...`;
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
