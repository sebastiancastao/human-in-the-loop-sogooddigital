import { NextResponse } from "next/server";
import { supabaseRestServer } from "@/lib/supabase/restServer";
import { buildCompanyOrFilter, companyUrlVariants, canonicalizeCompanyUrl } from "@/lib/company";

type InputMessage = { role: "user" | "assistant" | "system"; content: string };

type ParentRow = {
  company: string | null;
  social_entry: string | null;
  context: string | null;
  title: string | null;
  messages: unknown;
};

type RagRow = {
  id: string;
  title: string | null;
  social_entry: string | null;
  context: string | null;
  created_at: string;
};

type PromptSnippet = {
  id: string;
  title: string | null;
  content: string;
  createdAt: string;
};

type ContentPackController = {
  enabled: boolean;
  expectedIds: string[];
  idSource: "content_pack_id" | "result_row_index" | "none";
};

type CoverageCheck = {
  outputIds: string[];
  missingIds: string[];
};

type IdBlock = {
  id: string;
  block: string;
};

type ModelCallArgs = {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
};

type ModelCallResult =
  | { ok: true; reply: string }
  | { ok: false; providerError: string };

function getEnv(name: string): string | undefined {
  return process.env[name];
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  return Math.floor(n);
}

function parseBoundedFloat(
  value: string | undefined,
  min: number,
  max: number
): number | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function getAnthropicEnv(): {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
} {
  const apiKey = getEnv("ANTHROPIC_API_KEY");
  // Use a stable, fully-specified model by default (per Anthropic docs).
  const model = getEnv("ANTHROPIC_MODEL") ?? "claude-3-5-haiku-latest";
  const baseUrl = (getEnv("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com")
    .replace(/\/+$/, "");
  const maxTokens = parsePositiveInt(getEnv("ANTHROPIC_MAX_TOKENS")) ?? 8192;
  const temperature = parseBoundedFloat(getEnv("ANTHROPIC_TEMPERATURE"), 0, 1) ?? 0.2;
  const timeoutMs = parsePositiveInt(getEnv("ANTHROPIC_TIMEOUT_MS")) ?? 120000;

  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");
  return { apiKey, model, baseUrl, maxTokens, temperature, timeoutMs };
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

function normalizeChatTurns(
  messages: unknown
): { role: "user" | "assistant"; content: string }[] {
  if (!Array.isArray(messages)) return [];

  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const roleRaw = "role" in m ? (m as { role?: unknown }).role : undefined;
    const contentRaw =
      "content" in m ? (m as { content?: unknown }).content : undefined;

    let role: "user" | "assistant" | null = null;
    if (roleRaw === "assistant") role = "assistant";
    else if (roleRaw === "user" || roleRaw === "system") role = "user";
    if (!role) continue;

    const content = String(contentRaw ?? "").trim();
    if (!content) continue;
    out.push({ role, content });
  }

  return out;
}

function parseStoredTurnPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed;
      return [];
    } catch {
      return [];
    }
  }
  return [];
}

function sameTurn(
  a: { role: "user" | "assistant"; content: string } | undefined,
  b: { role: "user" | "assistant"; content: string } | undefined
): boolean {
  if (!a || !b) return false;
  return a.role === b.role && a.content.trim() === b.content.trim();
}

function mergeHistory(
  stored: { role: "user" | "assistant"; content: string }[],
  incoming: { role: "user" | "assistant"; content: string }[]
): { role: "user" | "assistant"; content: string }[] {
  if (stored.length === 0) return incoming;
  if (incoming.length === 0) return stored;

  // In normal flow the client sends full history; if it sends only the latest entry,
  // keep the stored history and append any missing tail messages.
  if (incoming.length >= stored.length) return incoming;

  const out = [...stored];
  for (const m of incoming) {
    if (!sameTurn(out[out.length - 1], m)) out.push(m);
  }
  return out;
}

function wantsAllSocialEntries(text: string | null): boolean {
  if (!text) return false;
  const q = text.toLowerCase();
  return (
    (q.includes("all") || q.includes("every")) &&
    (q.includes("social entry") ||
      q.includes("social entries") ||
      q.includes("entries from supabase") ||
      q.includes("entries in supabase"))
  );
}

function buildAllSocialEntriesReply(rows: RagRow[]): string {
  const entries = rows
    .map((r) => ({
      id: r.id,
      title: (r.title ?? "").trim() || "(untitled)",
      createdAt: r.created_at,
      socialEntry: (r.social_entry ?? "").trim(),
    }))
    .filter((r) => r.socialEntry.length > 0);

  if (entries.length === 0) {
    return "No social_entry values were found in Supabase for the selected results rows.";
  }

  const lines: string[] = [];
  lines.push(`Total social entries: ${entries.length}`);
  lines.push("");

  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    lines.push(`## ${i + 1}. ${e.title}`);
    lines.push(`id: ${e.id}`);
    lines.push(`created_at: ${e.createdAt}`);
    lines.push("social_entry:");
    lines.push(e.socialEntry);
    lines.push("");
  }

  return lines.join("\n").trim();
}

function buildSystemPrompt(args: {
  companyUrl: string | null;
  title: string;
  socialEntry: string | null;
  parentContext: string | null;
  results: PromptSnippet[];
  contexts: PromptSnippet[];
  controller: ContentPackController;
}): string {
  const lines: string[] = [];
  const compact = (text: string, max = 180) => {
    const oneLine = text.replace(/\s+/g, " ").trim();
    if (oneLine.length <= max) return oneLine;
    return `${oneLine.slice(0, max - 3).trimEnd()}...`;
  };
  const firstLine = (text: string) => {
    const line = text.split(/\r?\n/).find((x) => x.trim().length > 0) ?? "";
    return line.trim();
  };

  lines.push(
    "You are a helpful assistant. The user's task is based on the RESULTS data below.",
    "Use the CONTEXT section as supporting background information.",
    "If the data does not contain the answer, say what is missing and ask a clarifying question.",
    "You must use all loaded RESULTS rows, not only the most recent one."
  );
  if (args.controller.enabled) {
    lines.push("");
    lines.push("Mandatory output controller (must follow exactly):");
    lines.push("0. Do not ask questions. Do not ask the user to choose a method. Do not output planning text.");
    lines.push("1. Process EVERY content pack in the input. Do not skip any ID.");
    lines.push("2. Output count must exactly match input count.");
    lines.push("3. Keep placeholders unchanged, for example {{OFFICIAL_URL}}.");
    lines.push("3b. Start each pack with an exact line: ID: <id>.");
    lines.push(
      "4. For each ID, return sections in this order: Hook, CTA, Final Post, Variants (Curiosity-first, Story-first, Minimalist), Engagement Add-ons, Asset Brief."
    );
    lines.push(
      "5. If output is too long, stop at a clean boundary and write CONTINUE_FROM:<last_id>."
    );
    lines.push("6. End with a Coverage Check block using exactly this format:");
    lines.push("Input IDs: [id1, id2]");
    lines.push("Output IDs: [id1, id2]");
    lines.push("Missing IDs: []");
    lines.push(`Required Input IDs: [${args.controller.expectedIds.join(", ")}]`);
    if (args.controller.idSource === "result_row_index") {
      const rowMap = args.results
        .map((r, i) => {
          const title = (r.title ?? "").trim() || "(untitled)";
          return `ROW-${i + 1} => ${title}`;
        })
        .join(" | ");
      if (rowMap) lines.push(`Row mapping: ${rowMap}`);
    }
  }
  lines.push("");
  lines.push(`Conversation title: ${args.title}`);
  if (args.companyUrl) lines.push(`Company URL: ${args.companyUrl}`);
  if (args.socialEntry && args.results.length === 0 && args.contexts.length === 0) {
    lines.push(`Social entry: ${args.socialEntry}`);
  }
  if (args.parentContext?.trim()) {
    lines.push("");
    lines.push("Conversation context:");
    lines.push(args.parentContext.trim());
  }

  const formatSnippets = (items: PromptSnippet[]) =>
    items
      .map((c, i) => {
        const header = c.title?.trim() ? `#${i + 1} (${c.title.trim()})` : `#${i + 1}`;
        return `${header}\n${c.content.trim()}`;
      })
      .filter(Boolean);

  const formatIndex = (items: PromptSnippet[]) =>
    items
      .map((c, i) => {
        const date = c.createdAt ? c.createdAt.slice(0, 10) : "unknown-date";
        const label = c.title?.trim() || `row-${i + 1}`;
        return `#${i + 1} | ${date} | ${label} | ${compact(firstLine(c.content), 140)}`;
      })
      .join("\n");

  const res = formatSnippets(args.results);
  if (res.length) {
    lines.push("");
    lines.push(`Results rows loaded: ${args.results.length}`);
    lines.push("=== RESULTS INDEX (all rows) ===");
    lines.push(formatIndex(args.results));
    lines.push("");
    lines.push("=== RESULTS FULL TEXT (primary data) ===");
    lines.push(res.join("\n\n---\n\n"));
  }

  const ctx = formatSnippets(args.contexts);
  if (ctx.length) {
    lines.push("");
    lines.push(`Context rows loaded: ${args.contexts.length}`);
    lines.push("=== CONTEXT INDEX (all rows) ===");
    lines.push(formatIndex(args.contexts));
    lines.push("");
    lines.push("=== CONTEXT (supporting background information) ===");
    lines.push(ctx.join("\n\n---\n\n"));
  }

  return lines.join("\n");
}

function toTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";

  const isTextBlock = (b: unknown): b is { type: "text"; text?: unknown } => {
    if (!b || typeof b !== "object") return false;
    if (!("type" in b)) return false;
    return (b as { type?: unknown }).type === "text";
  };

  return content
    .map((b) => (isTextBlock(b) ? String(b.text ?? "") : ""))
    .join("");
}

function normalizeCompat(text: string): string {
  try {
    return text.normalize("NFKD");
  } catch {
    return text;
  }
}

function uniquePreserveOrder(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function looksLikeContentPack(text: string): boolean {
  const t = normalizeCompat(text).toLowerCase();
  const hasCore =
    (t.includes("content pack") || t.includes("final post")) &&
    (t.includes("variants") || t.includes("asset brief"));
  const hasFields = t.includes("hook") && t.includes("cta");
  return hasCore && hasFields;
}

function extractPackIds(text: string): string[] {
  const normalized = normalizeCompat(text);
  const out: string[] = [];

  const linePattern = /^\s*id\s*[:=]\s*([a-z0-9][a-z0-9._:-]{1,120})\s*$/gim;
  let m: RegExpExecArray | null;
  while ((m = linePattern.exec(normalized)) !== null) {
    out.push(m[1]);
  }

  const jsonPattern = /"id"\s*:\s*"([a-z0-9][a-z0-9._:-]{1,120})"/gim;
  while ((m = jsonPattern.exec(normalized)) !== null) {
    out.push(m[1]);
  }

  return uniquePreserveOrder(out);
}

function buildContentPackController(results: PromptSnippet[]): ContentPackController {
  const packLike = results.some((r) => looksLikeContentPack(r.content));
  if (!packLike) {
    return { enabled: false, expectedIds: [], idSource: "none" };
  }

  const extracted = uniquePreserveOrder(results.flatMap((r) => extractPackIds(r.content)));
  if (extracted.length > 0) {
    return {
      enabled: true,
      expectedIds: extracted,
      idSource: "content_pack_id",
    };
  }

  const fallbackRowIds = results.map((_, i) => `ROW-${i + 1}`);
  return {
    enabled: true,
    expectedIds: fallbackRowIds,
    idSource: "result_row_index",
  };
}

function isCoverageMarkerLine(line: string): boolean {
  const normalized = normalizeCompat(line).trim().toLowerCase();
  return (
    normalized.startsWith("coverage check") ||
    normalized.startsWith("[server coverage check]")
  );
}

function splitReplyIntoIdBlocks(reply: string, expectedIds: string[]): IdBlock[] {
  const expectedMap = new Map(expectedIds.map((id) => [id.toLowerCase(), id]));
  const lines = reply.split(/\r?\n/);
  const blocks: IdBlock[] = [];
  let currentId: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentId) return;
    const block = currentLines.join("\n").trim();
    if (block) blocks.push({ id: currentId, block });
    currentId = null;
    currentLines = [];
  };

  for (const line of lines) {
    if (isCoverageMarkerLine(line)) break;
    const normalizedLine = normalizeCompat(line).trim();
    const match = normalizedLine.match(
      /^(?:[-*]\s*)?(?:\*\*)?id(?:\*\*)?\s*:\s*([a-z0-9][a-z0-9._:-]{1,120})$/i
    );
    if (match) {
      flush();
      const canonical = expectedMap.get(match[1].toLowerCase());
      currentId = canonical ?? null;
      if (currentId) currentLines.push(`ID: ${currentId}`);
      continue;
    }
    if (currentId) currentLines.push(line);
  }

  flush();
  return blocks;
}

function mergeIdBlocks(existing: Map<string, string>, blocks: IdBlock[]): number {
  let added = 0;
  for (const b of blocks) {
    const prev = existing.get(b.id);
    if (!prev || b.block.length > prev.length) {
      existing.set(b.id, b.block);
      added += prev ? 0 : 1;
    }
  }
  return added;
}

function computeCoverageFromBlocks(
  expectedIds: string[],
  blocksById: Map<string, string>
): CoverageCheck {
  const expected = uniquePreserveOrder(expectedIds);
  const outputIds = expected.filter((id) => blocksById.has(id));
  const outputSet = new Set(outputIds.map((id) => id.toLowerCase()));
  const missingIds = expected.filter((id) => !outputSet.has(id.toLowerCase()));
  return { outputIds, missingIds };
}

function buildCoverageRepairInstruction(args: {
  expectedIds: string[];
  targetIds: string[];
  alreadyCompletedIds: string[];
}): string {
  const lines: string[] = [];
  lines.push("Continue generation immediately.");
  lines.push("Do not ask questions. Do not ask the user to choose an approach. Do not output planning text.");
  lines.push("Output content packs directly.");
  lines.push(`Global expected IDs: [${args.expectedIds.join(", ")}]`);
  lines.push(`Generate ONLY these IDs in this pass: [${args.targetIds.join(", ")}]`);
  lines.push(`Already completed IDs (do not repeat): [${args.alreadyCompletedIds.join(", ")}]`);
  lines.push("For each pack, the first line must be exactly: ID: <id>.");
  lines.push("Keep placeholders unchanged, for example {{OFFICIAL_URL}}.");
  lines.push(
    "For each ID, include sections in this order: Hook, CTA, Final Post, Variants (Curiosity-first, Story-first, Minimalist), Engagement Add-ons, Asset Brief."
  );
  lines.push(
    "If output gets long, stop only at a full pack boundary and end with CONTINUE_FROM:<last_id>."
  );
  lines.push("End with this exact coverage block format for this pass:");
  lines.push(`Input IDs: [${args.targetIds.join(", ")}]`);
  lines.push("Output IDs: [id1, id2]");
  lines.push("Missing IDs: []");
  return lines.join("\n");
}

function buildServerCoverageCheckBlock(args: {
  inputIds: string[];
  outputIds: string[];
  missingIds: string[];
}): string {
  return [
    "[SERVER COVERAGE CHECK]",
    `Input IDs: [${args.inputIds.join(", ")}]`,
    `Output IDs: [${args.outputIds.join(", ")}]`,
    `Missing IDs: [${args.missingIds.join(", ")}]`,
  ].join("\n");
}

function compileReplyFromBlocks(expectedIds: string[], blocksById: Map<string, string>): string {
  const blocks = expectedIds
    .map((id) => blocksById.get(id)?.trim() ?? "")
    .filter((b) => b.length > 0);
  return blocks.join("\n\n");
}

async function callAnthropic(args: ModelCallArgs): Promise<ModelCallResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  let res: Response | null = null;
  try {
    res = await fetch(`${args.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": args.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: args.model,
        max_tokens: args.maxTokens,
        temperature: args.temperature,
        system: args.system,
        messages: args.messages,
      }),
      signal: controller.signal,
    }).catch((e) => {
      if (e instanceof Error && e.name === "AbortError") {
        return null;
      }
      throw e;
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res) {
    return {
      ok: false,
      providerError: `Anthropic request timed out after ${args.timeoutMs}ms`,
    };
  }

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, providerError: text };
  }

  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return {
      ok: false,
      providerError: `Invalid provider JSON response: ${text.slice(0, 2000)}`,
    };
  }

  const content = (json && typeof json === "object" && "content" in json)
    ? (json as { content?: unknown }).content
    : undefined;
  const reply = toTextBlocks(content).trim();
  if (!reply) return { ok: false, providerError: "Empty model response" };

  return { ok: true, reply };
}

function resolveConversationTitle(args: {
  title: string | null;
  socialEntry: string | null;
  companyUrl: string | null;
}): string {
  const explicit = (args.title ?? "").trim();
  if (explicit) return explicit;

  const socialFirstLine = (args.socialEntry ?? "").split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (socialFirstLine) {
    return socialFirstLine.length > 60
      ? `${socialFirstLine.slice(0, 57).trimEnd()}...`
      : socialFirstLine;
  }

  if (args.companyUrl) {
    try {
      return new URL(args.companyUrl).hostname;
    } catch {
      return args.companyUrl;
    }
  }

  return "Conversation";
}

function compactSnippet(text: string, max = 320): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3).trimEnd()}...`;
}

function buildFallbackReply(args: {
  providerError: string;
  companyUrl: string | null;
  title: string;
  latestUserMessage: string | null;
  results: PromptSnippet[];
  contexts: PromptSnippet[];
}): string {
  const lowCredits = /credit balance is too low/i.test(args.providerError);
  const snippets = [...args.results, ...args.contexts];
  const snippetBlock =
    snippets.length > 0
      ? snippets
          .map((s, i) => {
            const heading = s.title?.trim() ? `${i + 1}. ${s.title.trim()}` : `${i + 1}. Source`;
            return `${heading}\n${compactSnippet(s.content)}`;
          })
          .join("\n\n")
      : "No stored results/context were found for this conversation.";

  const lines: string[] = [];
  lines.push("I could not reach the configured language model, so this is a fallback response from stored data.");
  if (lowCredits) {
    lines.push("Anthropic API credits are currently exhausted.");
  }
  lines.push(`Conversation: ${args.title}`);
  if (args.companyUrl) lines.push(`Company URL: ${args.companyUrl}`);
  if (args.latestUserMessage) {
    lines.push(`Latest request: ${compactSnippet(args.latestUserMessage, 180)}`);
  }
  lines.push("");
  lines.push("Relevant data:");
  lines.push(snippetBlock);
  if (lowCredits) {
    lines.push("");
    lines.push("Add Anthropic credits and retry to restore full AI responses.");
  }

  return lines.join("\n");
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
        select: "company,social_entry,context,title,messages",
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
    const companyCanon = canonicalizeCompanyUrl(companyUrl) ?? canonicalizeCompanyUrl(p.social_entry) ?? null;
    const companyFilterVariants = companyUrlVariants(companyUrl ?? companyCanon);
    const companyOr = buildCompanyOrFilter(companyFilterVariants);

    // Fetch both results and context rows for the company (or by title fallback).
    let resultsRows: RagRow[] = [];
    let contextRows: RagRow[] = [];

    if (companyUrl || companyCanon) {
      const eqCompany = companyFilterVariants.length === 1 ? companyFilterVariants[0] : (companyUrl ?? companyCanon!);
      [resultsRows, contextRows] = await Promise.all([
        supabaseRestServer<RagRow[]>("/sogood_rag", {
          query: {
            select: "id,title,social_entry,context,created_at",
            type: "eq.results",
            ...(companyOr ? { or: companyOr } : { company: `eq.${eqCompany}` }),
            order: "created_at.asc",
          },
        }),
        supabaseRestServer<RagRow[]>("/sogood_rag", {
          query: {
            select: "id,title,social_entry,context,created_at",
            type: "eq.context",
            ...(companyOr ? { or: companyOr } : { company: `eq.${eqCompany}` }),
            order: "created_at.asc",
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
            order: "created_at.asc",
          },
        }),
        supabaseRestServer<RagRow[]>("/sogood_rag", {
          query: {
            select: "id,title,social_entry,context,created_at",
            type: "eq.context",
            title: `eq.${p.title}`,
            order: "created_at.asc",
          },
        }),
      ]);
    }

    const toSnippets = (rows: RagRow[]): PromptSnippet[] =>
      rows
        .map((r) => ({
          id: r.id,
          title: r.title,
          content: (r.context ?? r.social_entry ?? "").trim(),
          createdAt: r.created_at,
        }))
        .filter((r) => r.content.length > 0);

    const results = toSnippets(resultsRows);
    const contexts = toSnippets(contextRows);
    const conversationTitle = resolveConversationTitle({
      title: p.title,
      socialEntry: p.social_entry ?? null,
      companyUrl: companyCanon ?? companyUrl,
    });

    const controller = buildContentPackController(results);
    const system = buildSystemPrompt({
      companyUrl: companyCanon ?? companyUrl,
      title: conversationTitle,
      socialEntry: p.social_entry ?? null,
      parentContext: p.context ?? null,
      results,
      contexts,
      controller,
    });

    const incomingTurns = normalizeChatTurns(inputMessages);
    const storedTurns = normalizeChatTurns(parseStoredTurnPayload(p.messages));
    const convoMessages = mergeConsecutive(mergeHistory(storedTurns, incomingTurns));

    const hasUser = convoMessages.some((m) => m.role === "user");
    if (!hasUser) {
      return NextResponse.json(
        { error: "At least one user message is required" },
        { status: 400 }
      );
    }

    const latestUserMessage =
      [...convoMessages].reverse().find((m) => m.role === "user")?.content?.trim() ??
      null;

    if (wantsAllSocialEntries(latestUserMessage)) {
      const allResultsRows = await supabaseRestServer<RagRow[]>("/sogood_rag", {
        query: {
          select: "id,title,social_entry,context,created_at",
          type: "eq.results",
          order: "created_at.asc",
        },
      });

      return NextResponse.json({
        reply: buildAllSocialEntriesReply(allResultsRows),
        meta: {
          mode: "all_social_entries",
          resultsCount: allResultsRows.length,
          contextsCount: contexts.length,
          messageTurns: convoMessages.length,
        },
      });
    }

    const { apiKey, model, baseUrl, maxTokens, temperature, timeoutMs } = getAnthropicEnv();
    const meta = {
      model,
      maxTokens,
      temperature,
      timeoutMs,
      resultsCount: results.length,
      contextsCount: contexts.length,
      systemChars: system.length,
      messageTurns: convoMessages.length,
      contentPackController: {
        enabled: controller.enabled,
        idSource: controller.idSource,
        expectedIds: controller.expectedIds,
      },
    };
    const firstCall = await callAnthropic({
      apiKey,
      model,
      baseUrl,
      maxTokens,
      temperature,
      timeoutMs,
      system,
      messages: convoMessages,
    });
    if (!firstCall.ok) {
      const fallbackReply = buildFallbackReply({
        providerError: firstCall.providerError,
        companyUrl: companyCanon ?? companyUrl,
        title: conversationTitle,
        latestUserMessage,
        results,
        contexts,
      });
      return NextResponse.json(
        {
          reply: fallbackReply,
          fallback: true,
          providerError: firstCall.providerError.slice(0, 2000),
          meta,
        },
        { status: 200 }
      );
    }

    let reply = firstCall.reply;
    const blocksById = new Map<string, string>();
    mergeIdBlocks(blocksById, splitReplyIntoIdBlocks(reply, controller.expectedIds));

    let coverage: CoverageCheck = controller.enabled
      ? computeCoverageFromBlocks(controller.expectedIds, blocksById)
      : { outputIds: [], missingIds: [] };
    let repairAttempted = false;
    let repairSucceeded = false;
    let repairPasses = 0;
    const repairProviderErrors: string[] = [];

    if (controller.enabled && coverage.missingIds.length > 0) {
      repairAttempted = true;
      const batchSize = parsePositiveInt(getEnv("CONTENT_PACK_BATCH_SIZE")) ?? 6;
      const maxPasses = parsePositiveInt(getEnv("CONTENT_PACK_MAX_PASSES")) ?? 12;
      let stalledPasses = 0;

      while (coverage.missingIds.length > 0 && repairPasses < maxPasses && stalledPasses < 2) {
        const targetIds = coverage.missingIds.slice(0, batchSize);
        const repairInstruction = buildCoverageRepairInstruction({
          expectedIds: controller.expectedIds,
          targetIds,
          alreadyCompletedIds: coverage.outputIds,
        });
        const repairedCall = await callAnthropic({
          apiKey,
          model,
          baseUrl,
          maxTokens,
          temperature,
          timeoutMs,
          system,
          messages: [
            ...convoMessages,
            { role: "assistant", content: "Continue the generation now." },
            { role: "user", content: repairInstruction },
          ],
        });
        repairPasses += 1;

        if (!repairedCall.ok) {
          repairProviderErrors.push(repairedCall.providerError.slice(0, 2000));
          stalledPasses += 1;
          continue;
        }

        reply = repairedCall.reply;
        const before = blocksById.size;
        mergeIdBlocks(blocksById, splitReplyIntoIdBlocks(reply, controller.expectedIds));
        const after = blocksById.size;
        stalledPasses = after > before ? 0 : stalledPasses + 1;
        coverage = computeCoverageFromBlocks(controller.expectedIds, blocksById);
      }

      repairSucceeded = coverage.missingIds.length === 0;
      const compiled = compileReplyFromBlocks(controller.expectedIds, blocksById).trim();
      if (compiled) reply = compiled;
    }

    if (controller.enabled && coverage.missingIds.length > 0) {
      reply = [
        reply.trim(),
        "",
        buildServerCoverageCheckBlock({
          inputIds: controller.expectedIds,
          outputIds: coverage.outputIds,
          missingIds: coverage.missingIds,
        }),
      ].join("\n");
    }

    return NextResponse.json({
      reply,
      meta: {
        ...meta,
        coverage: {
          expectedIds: controller.expectedIds,
          outputIds: coverage.outputIds,
          missingIds: coverage.missingIds,
          repairAttempted,
          repairSucceeded,
          repairPasses,
          repairProviderErrors,
        },
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
