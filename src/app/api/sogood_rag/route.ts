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

  // Group by company so the UI sees one conversation per company.
  // (Some datasets also store company URLs with minor variations like trailing slashes or UTM params.)
  const byCompanyKey = new Map<string, SogoodRagRow[]>();
  const companyKeyForRow = (r: SogoodRagRow): string => {
    const canon =
      canonicalizeCompanyUrl(r.company) ??
      canonicalizeCompanyUrl(r.social_entry) ??
      null;
    if (canon) return `company:${canon}`;
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

    // Build a separate "results" collection from sibling rows (exclude the primary chat thread).
    // Only include rows that look like ingested results (no chat messages, but have content).
    const results = group
      .filter((x) => x.id !== r.id)
      .filter((x) => !Array.isArray(x.messages) || x.messages.length === 0)
      .map((x) => ({
        id: x.id,
        title: x.title ?? null,
        content: (x.context ?? x.social_entry ?? "").trim(),
        createdAt: new Date(x.created_at).getTime(),
      }))
      .filter((x) => x.content.length > 0)
      .sort((a, b) => a.createdAt - b.createdAt);

    return {
      id: r.id,
      title: r.title,
      messages: normalizeMessages({
        conversationId: r.id,
        createdAt,
        socialEntry: r.social_entry ?? undefined,
        messages: ((r.messages ?? []) as Message[]) ?? [],
      }),
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
  const body = (await req.json().catch(() => null)) as Conversation | null;
  if (!body?.id || !body.title || !Array.isArray(body.messages)) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const type = body.type ?? "results";
  const firstSystem =
    body.messages.find((m) => m.role === "system")?.content ?? null;
  const firstUser = body.messages.find((m) => m.role === "user")?.content ?? null;
  const socialEntry = body.socialEntry ?? firstSystem ?? firstUser;
  const company = canonicalizeCompanyUrl(socialEntry);
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
    company: canonicalizeCompanyUrl(savedRow.company) ?? canonicalizeCompanyUrl(savedRow.social_entry) ?? undefined,
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
