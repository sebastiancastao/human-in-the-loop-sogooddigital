import { NextResponse } from "next/server";
import { supabaseRestServer } from "@/lib/supabase/restServer";

type InputMessage = { role: "user" | "assistant" | "system"; content: string };

type ParentRow = {
  company: string | null;
  social_entry: string | null;
  context: string | null;
  title: string;
};

type RagRow = {
  id: string;
  title: string | null;
  social_entry: string | null;
  context: string | null;
  created_at: string;
};

function getEnv(name: string): string | undefined {
  return process.env[name];
}

function getAnthropicEnv(): { apiKey: string; model: string; baseUrl: string } {
  const apiKey = getEnv("ANTHROPIC_API_KEY");
  // Use a stable, fully-specified model by default (per Anthropic docs).
  const model = getEnv("ANTHROPIC_MODEL") ?? "claude-sonnet-4-20250514";
  const baseUrl = (getEnv("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com")
    .replace(/\/+$/, "");

  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");
  return { apiKey, model, baseUrl };
}

function mergeConsecutive(
  messages: { role: "user" | "assistant"; content: string }[]
): { role: "user" | "assistant"; content: string }[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    const content = (m.content ?? "").trim();
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${content}`;
      continue;
    }
    out.push({ role: m.role, content });
  }
  return out;
}

function buildSystemPrompt(args: {
  companyUrl: string | null;
  title: string;
  socialEntry: string | null;
  parentContext: string | null;
  results: { title: string | null; content: string }[];
  contexts: { title: string | null; content: string }[];
}): string {
  const lines: string[] = [];
  lines.push(
    "You are a helpful assistant. The user's task is based on the RESULTS data below.",
    "Use the CONTEXT section as supporting background information.",
    "If the data does not contain the answer, say what is missing and ask a clarifying question."
  );
  lines.push("");
  lines.push(`Conversation title: ${args.title}`);
  if (args.companyUrl) lines.push(`Company URL: ${args.companyUrl}`);
  if (args.socialEntry) lines.push(`Social entry: ${args.socialEntry}`);
  if (args.parentContext?.trim()) {
    lines.push("");
    lines.push("Conversation context:");
    lines.push(args.parentContext.trim());
  }

  const formatSnippets = (items: { title: string | null; content: string }[]) =>
    items
      .map((c, i) => {
        const header = c.title?.trim() ? `#${i + 1} (${c.title.trim()})` : `#${i + 1}`;
        return `${header}\n${c.content.trim()}`;
      })
      .filter(Boolean);

  const res = formatSnippets(args.results);
  if (res.length) {
    lines.push("");
    lines.push("=== RESULTS (primary data — the task is about these) ===");
    lines.push(res.join("\n\n---\n\n"));
  }

  const ctx = formatSnippets(args.contexts);
  if (ctx.length) {
    lines.push("");
    lines.push("=== CONTEXT (supporting background information) ===");
    lines.push(ctx.join("\n\n---\n\n"));
  }

  return lines.join("\n");
}

function toTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as any).type === "text" ? String((b as any).text ?? "") : ""))
    .join("");
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as
      | { conversationId?: string; messages?: InputMessage[] }
      | null;
    const conversationId = body?.conversationId;
    const inputMessages = body?.messages;

    if (!conversationId || typeof conversationId !== "string") {
      return NextResponse.json({ error: "Missing conversationId" }, { status: 400 });
    }
    if (!Array.isArray(inputMessages)) {
      return NextResponse.json({ error: "Missing messages" }, { status: 400 });
    }

    const parent = await supabaseRestServer<ParentRow[]>("/sogood_rag", {
      query: {
        select: "company,social_entry,context,title",
        id: `eq.${conversationId}`,
        type: "eq.results",
        limit: 1,
      },
    });

    const p = parent?.[0];
    if (!p) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    const companyUrl = p.company ?? null;

    // Fetch both results and context rows for the company (or by title fallback).
    let resultsRows: RagRow[] = [];
    let contextRows: RagRow[] = [];

    if (companyUrl) {
      [resultsRows, contextRows] = await Promise.all([
        supabaseRestServer<RagRow[]>("/sogood_rag", {
          query: {
            select: "id,title,social_entry,context,created_at",
            type: "eq.results",
            company: `eq.${companyUrl}`,
            id: `neq.${conversationId}`,  // exclude the conversation row itself
            order: "created_at.asc",
            limit: 25,
          },
        }),
        supabaseRestServer<RagRow[]>("/sogood_rag", {
          query: {
            select: "id,title,social_entry,context,created_at",
            type: "eq.context",
            company: `eq.${companyUrl}`,
            order: "created_at.asc",
            limit: 25,
          },
        }),
      ]);
    } else if (p.title) {
      [resultsRows, contextRows] = await Promise.all([
        supabaseRestServer<RagRow[]>("/sogood_rag", {
          query: {
            select: "id,title,social_entry,context,created_at",
            type: "eq.results",
            title: `eq.${p.title}`,
            id: `neq.${conversationId}`,
            order: "created_at.asc",
            limit: 25,
          },
        }),
        supabaseRestServer<RagRow[]>("/sogood_rag", {
          query: {
            select: "id,title,social_entry,context,created_at",
            type: "eq.context",
            title: `eq.${p.title}`,
            order: "created_at.asc",
            limit: 25,
          },
        }),
      ]);
    }

    const toSnippets = (rows: RagRow[]) =>
      rows
        .map((r) => ({
          title: r.title,
          content: (r.context ?? r.social_entry ?? "").trim(),
        }))
        .filter((r) => r.content.length > 0)
        .map((r) => ({
          ...r,
          content: r.content.length > 4000 ? `${r.content.slice(0, 4000)}…` : r.content,
        }));

    const results = toSnippets(resultsRows);
    const contexts = toSnippets(contextRows);

    const system = buildSystemPrompt({
      companyUrl,
      title: p.title,
      socialEntry: p.social_entry ?? null,
      parentContext: p.context ?? null,
      results,
      contexts,
    });

    const convoMessages = mergeConsecutive(
      inputMessages
        .filter((m): m is InputMessage => !!m && typeof m === "object")
        .filter((m): m is InputMessage & { role: "user" | "assistant" } =>
          m.role === "user" || m.role === "assistant"
        )
        .map((m) => ({ role: m.role, content: String(m.content ?? "") }))
    );

    const hasUser = convoMessages.some((m) => m.role === "user");
    if (!hasUser) {
      return NextResponse.json(
        { error: "At least one user message is required" },
        { status: 400 }
      );
    }

    const { apiKey, model, baseUrl } = getAnthropicEnv();
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system,
        messages: convoMessages,
      }),
    });

    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { error: "Anthropic error", details: text.slice(0, 2000) },
        { status: 502 }
      );
    }

    const json = JSON.parse(text) as any;
    const reply = toTextBlocks(json?.content);
    if (!reply.trim()) {
      return NextResponse.json(
        { error: "Empty model response", raw: json },
        { status: 502 }
      );
    }

    return NextResponse.json({ reply });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

