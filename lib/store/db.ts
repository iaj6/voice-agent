import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

/**
 * Lazily constructed database handle.
 *
 * Lazy because `neon()` throws when DATABASE_URL is unset, and Next.js evaluates
 * top-level module code at build time — an eager client crashes `next build` on
 * any machine without the env var. A plain function rather than a Proxy: Proxy
 * wrappers intercept property checks that libraries use to inspect a client and
 * fail in ways that surface as hangs rather than errors.
 */
let handle: NeonQueryFunction<false, false> | null = null;

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function getDb(): NeonQueryFunction<false, false> {
  if (!handle) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set. Run `vercel env pull` or use the in-memory store.",
      );
    }
    handle = neon(url);
  }
  return handle;
}
