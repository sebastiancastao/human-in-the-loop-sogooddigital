function getEnv(name: string): string | undefined {
  // Next replaces NEXT_PUBLIC_* at build-time for browser bundles.
  return process.env[name];
}

export function getSupabasePublicEnv(): { url: string; anonKey: string } {
  const url = getEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY"
    );
  }

  return { url, anonKey };
}

export function getSupabaseServerEnv(): { url: string; anonKey: string } {
  // Allow server-only names too, but default to NEXT_PUBLIC_* for simplicity.
  const url = getEnv("SUPABASE_URL") ?? getEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey =
    getEnv("SUPABASE_ANON_KEY") ?? getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  if (!url || !anonKey) {
    throw new Error("Missing SUPABASE_URL/SUPABASE_ANON_KEY (or NEXT_PUBLIC_*)");
  }

  return { url, anonKey };
}

