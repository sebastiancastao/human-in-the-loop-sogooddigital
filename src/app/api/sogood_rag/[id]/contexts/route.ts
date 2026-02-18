import { NextResponse } from "next/server";
import { supabaseRestServer } from "@/lib/supabase/restServer";
import { buildCompanyOrFilter, companyUrlVariants, canonicalizeCompanyUrl } from "@/lib/company";

type ContextRow = {
  id: string;
  company: string | null;
  type: string | null;
  title: string | null;
  social_entry: string | null;
  context: string | null;
  created_at: string;
};

type ParentLinkRow = {
  company: string | null;
  title: string | null;
  social_entry: string | null;
};

function normalizeCompanyValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return canonicalizeCompanyUrl(trimmed) ?? trimmed;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const debugEnabled =
    url.searchParams.get("debug") === "1" ||
    process.env.DEBUG_CONTEXT_EXPORT === "1";
  const debug: Record<string, unknown> = {
    conversationId: id,
    debugEnabled,
  };

  try {
    // Prefer explicit linking by `company` (a text URL).
    // If `company` is missing, fall back to title matching (older data).
    const parent = await supabaseRestServer<ParentLinkRow[]>("/sogood_rag", {
      query: {
        select: "company,title,social_entry",
        id: `eq.${id}`,
        limit: 1,
      },
    });
    const parentRow = parent?.[0] ?? null;
    const parentTitle = parentRow?.title ?? null;
    let companyUrl =
      normalizeCompanyValue(parentRow?.company) ??
      canonicalizeCompanyUrl(parentRow?.social_entry) ??
      null;

    if (debugEnabled) {
      debug.parentRow = parentRow
        ? {
            company: parentRow.company,
            title: parentRow.title,
            social_entry: parentRow.social_entry,
          }
        : null;
      debug.parentFound = Boolean(parentRow);
    }

    // Fallback: some chat rows lack company, while sibling results rows have it.
    if (!companyUrl && parentTitle) {
      const siblings = await supabaseRestServer<ParentLinkRow[]>("/sogood_rag", {
        query: {
          select: "company,social_entry,title",
          type: "eq.results",
          title: `eq.${parentTitle}`,
          order: "created_at.desc",
          limit: 25,
        },
      });
      if (debugEnabled) {
        debug.siblingResultsChecked = siblings.length;
      }
      for (const s of siblings) {
        const maybe =
          normalizeCompanyValue(s.company) ??
          canonicalizeCompanyUrl(s.social_entry);
        if (maybe) {
          companyUrl = maybe;
          break;
        }
      }
    }
    const companyTitle = parentTitle;

    let rows: ContextRow[] = [];
    if (companyUrl) {
      const companyCanon = canonicalizeCompanyUrl(companyUrl);
      const variants = companyUrlVariants(companyUrl ?? companyCanon);
      const companyOr = buildCompanyOrFilter(variants);
      const eqCompany = variants.length === 1 ? variants[0] : (companyUrl ?? companyCanon!);
      if (debugEnabled) {
        debug.resolvedCompany = companyUrl;
        debug.companyVariants = variants;
        debug.companyFilter = companyOr ? { or: companyOr } : { company: `eq.${eqCompany}` };
      }
      rows = await supabaseRestServer<ContextRow[]>("/sogood_rag", {
        query: {
          select: "id,company,type,title,social_entry,context,created_at",
          type: "eq.context",
          ...(companyOr ? { or: companyOr } : { company: `eq.${eqCompany}` }),
          order: "created_at.asc",
        },
      });
      if (debugEnabled) debug.companyMatchCount = rows.length;
    } else if (debugEnabled) {
      debug.resolvedCompany = null;
    }

    if (rows.length === 0 && companyTitle) {
      rows = await supabaseRestServer<ContextRow[]>("/sogood_rag", {
        query: {
          select: "id,company,type,title,social_entry,context,created_at",
          type: "eq.context",
          title: `eq.${companyTitle}`,
          order: "created_at.asc",
        },
      });
      if (debugEnabled) {
        debug.usedTitleFallback = true;
        debug.titleFallback = companyTitle;
        debug.titleMatchCount = rows.length;
      }
    }

    // Normalize to a simple shape for the UI.
    const contexts = rows.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.context ?? r.social_entry ?? "",
      createdAt: new Date(r.created_at).getTime(),
    }));

    if (debugEnabled) {
      debug.returnedContexts = contexts.length;
      return NextResponse.json({ contexts, debug });
    }
    return NextResponse.json({ contexts });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Failed to load context rows";
    if (debugEnabled) {
      debug.error = error;
      return NextResponse.json({ contexts: [], debug }, { status: 500 });
    }
    return NextResponse.json({ error }, { status: 500 });
  }
}
