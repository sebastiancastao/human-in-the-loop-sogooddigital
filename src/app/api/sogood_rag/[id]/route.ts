import { NextResponse } from "next/server";
import type { Conversation, Message } from "@/types/chat";
import { supabaseRestServer } from "@/lib/supabase/restServer";
import { buildCompanyOrFilter, canonicalizeCompanyUrl, companyUrlVariants } from "@/lib/company";

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

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const rows = await supabaseRestServer<SogoodRagRow[]>("/sogood_rag", {
    query: {
      select: "id,company,type,social_entry,context,title,messages,created_at",
      id: `eq.${id}`,
      limit: 1,
    },
  });

  const r = rows?.[0];
  if (!r) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const conversation: Conversation = {
    id: r.id,
    messages: normalizeMessages({
      conversationId: r.id,
      createdAt: new Date(r.created_at).getTime(),
      socialEntry: r.social_entry ?? undefined,
      messages: parseStoredMessages(r.messages),
    }),
    title: resolveConversationTitle({
      id: r.id,
      title: r.title,
      socialEntry: r.social_entry,
      company: r.company,
      messages: parseStoredMessages(r.messages),
    }),
    createdAt: new Date(r.created_at).getTime(),
    type: r.type ?? "results",
    company: canonicalizeCompanyUrl(r.company) ?? canonicalizeCompanyUrl(r.social_entry) ?? undefined,
    socialEntry: r.social_entry ?? undefined,
    context: r.context ?? undefined,
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

  const first = msgs[0];
  if (first && first.content.trim() === social && first.role !== "assistant") {
    msgs[0] = { ...first, role: "system" };
    return msgs;
  }

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

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;

  // Delete context rows first.
  // `company` is a text URL, so we need to load the parent row to know which contexts to delete.
  const parent = await supabaseRestServer<{ company: string | null; title: string }[]>(
    "/sogood_rag",
    {
      query: { select: "company,title", id: `eq.${id}`, limit: 1 },
    }
  );
  const companyUrl = parent?.[0]?.company ?? null;
  const parentTitle = parent?.[0]?.title ?? null;

  if (companyUrl) {
    const companyCanon = canonicalizeCompanyUrl(companyUrl);
    const variants = companyUrlVariants(companyUrl ?? companyCanon);
    const companyOr = buildCompanyOrFilter(variants);
    const eqCompany = variants.length === 1 ? variants[0] : (companyUrl ?? companyCanon!);
    await supabaseRestServer<void>("/sogood_rag", {
      method: "DELETE",
      query: {
        type: "eq.context",
        ...(companyOr ? { or: companyOr } : { company: `eq.${eqCompany}` }),
      },
    });
  } else if (parentTitle) {
    // Back-compat: some older rows linked contexts by title.
    await supabaseRestServer<void>("/sogood_rag", {
      method: "DELETE",
      query: { title: `eq.${parentTitle}`, type: "eq.context" },
    });
  }

  await supabaseRestServer<void>("/sogood_rag", {
    method: "DELETE",
    query: { id: `eq.${id}` },
  });

  return NextResponse.json({ ok: true });
}
