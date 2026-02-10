export function canonicalizeCompanyUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (!/^https?:\/\/\S+/i.test(raw)) return null;

  try {
    const u = new URL(raw);
    u.hash = "";
    u.search = "";

    // Canonicalize host casing.
    u.hostname = u.hostname.toLowerCase();

    // Drop default ports.
    if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) {
      u.port = "";
    }

    // Normalize trailing slashes in the pathname (keep root as "/").
    if (u.pathname && u.pathname !== "/") {
      u.pathname = u.pathname.replace(/\/+$/, "");
      if (!u.pathname) u.pathname = "/";
    }

    return u.toString();
  } catch {
    // If it looks like a URL but can't be parsed, don't store it as a company identifier.
    return null;
  }
}

function toggleTrailingSlash(url: string): string {
  try {
    const u = new URL(url);
    if (u.pathname === "/") return u.toString(); // nothing to toggle
    u.pathname = u.pathname.endsWith("/") ? u.pathname.replace(/\/+$/, "") : `${u.pathname}/`;
    return u.toString();
  } catch {
    return url;
  }
}

export function companyUrlVariants(value: string | null | undefined): string[] {
  if (!value) return [];
  const raw = value.trim();
  if (!raw) return [];

  const canon = canonicalizeCompanyUrl(raw) ?? raw;
  const variants = [raw, canon, toggleTrailingSlash(raw), toggleTrailingSlash(canon)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of variants) {
    const t = v.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function buildCompanyOrFilter(variants: string[]): string | null {
  const vs = variants.filter(Boolean);
  if (vs.length === 0) return null;
  if (vs.length === 1) return null; // prefer `company=eq.<v>` for the single-variant case
  // PostgREST `or` syntax: or=(company.eq.VALUE,company.eq.VALUE2)
  return `(${vs.map((v) => `company.eq.${v}`).join(",")})`;
}

