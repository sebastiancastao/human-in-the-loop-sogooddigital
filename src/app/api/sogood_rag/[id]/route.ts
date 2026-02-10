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
  title: string;
  messages: Message[] | null;
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
    title: r.title,
    messages: normalizeMessages({
      conversationId: r.id,
      createdAt: new Date(r.created_at).getTime(),
      socialEntry: r.social_entry ?? undefined,
      messages: (r.messages ?? []) as Message[],
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
