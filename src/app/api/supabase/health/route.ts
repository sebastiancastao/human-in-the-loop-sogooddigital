import { NextResponse } from "next/server";
import { getSupabaseServerEnv } from "@/lib/supabase/env";

export async function GET() {
  const { url, anonKey } = getSupabaseServerEnv();
  const healthUrl = `${url.replace(/\/+$/, "")}/auth/v1/health`;

  const res = await fetch(healthUrl, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    },
    cache: "no-store",
  });

  const text = await res.text().catch(() => "");
  return NextResponse.json(
    {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      body: text ? safeJson(text) : null,
    },
    { status: res.ok ? 200 : 502 }
  );
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

