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

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;

  // Prefer explicit linking by `company` (a text URL).
  // If `company` is missing, fall back to title matching (older data).
  const parent = await supabaseRestServer<{ company: string | null; title: string }[]>("/sogood_rag", {
    query: {
      select: "company,title",
      id: `eq.${id}`,
      type: "eq.results",
      limit: 1,
    },
  });
  const companyUrl = parent?.[0]?.company ?? null;
  const companyTitle = parent?.[0]?.title ?? null;

  let rows: ContextRow[] = [];
  if (companyUrl) {
    const companyCanon = canonicalizeCompanyUrl(companyUrl);
    const variants = companyUrlVariants(companyUrl ?? companyCanon);
    const companyOr = buildCompanyOrFilter(variants);
    const eqCompany = variants.length === 1 ? variants[0] : (companyUrl ?? companyCanon!);
    rows = await supabaseRestServer<ContextRow[]>("/sogood_rag", {
      query: {
        select: "id,company,type,title,social_entry,context,created_at",
        type: "eq.context",
        ...(companyOr ? { or: companyOr } : { company: `eq.${eqCompany}` }),
        order: "created_at.asc",
      },
    });
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
  }

  // Normalize to a simple shape for the UI.
  const contexts = rows.map((r) => ({
    id: r.id,
    title: r.title,
    content: r.context ?? r.social_entry ?? "",
    createdAt: new Date(r.created_at).getTime(),
  }));

  return NextResponse.json({ contexts });
}
