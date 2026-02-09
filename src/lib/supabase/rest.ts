import { getSupabasePublicEnv } from "./env";

type Query = Record<string, string | number | boolean | null | undefined>;

export type SupabaseRestOptions = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Query;
  headers?: Record<string, string>;
  body?: unknown;
  /**
   * PostgREST Prefer header, e.g. "return=representation".
   * Defaults to undefined.
   */
  prefer?: string;
};

export async function supabaseRest<T>(
  path: string,
  options: SupabaseRestOptions = {}
): Promise<T> {
  const { url, anonKey } = getSupabasePublicEnv();
  const restBase = `${url.replace(/\/+$/, "")}/rest/v1`;

  const u = new URL(`${restBase}${path.startsWith("/") ? path : `/${path}`}`);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
  };
  if (options.prefer) headers.Prefer = options.prefer;
  if (options.body) headers["Content-Type"] = "application/json";
  if (options.headers) Object.assign(headers, options.headers);

  const res = await fetch(u, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Supabase REST error ${res.status} ${res.statusText}: ${text.slice(
        0,
        500
      )}`
    );
  }

  // PostgREST may return 204 No Content for deletes/updates without Prefer.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
