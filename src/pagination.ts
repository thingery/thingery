// Pure pagination helpers for the /browse page.
// No I/O — unit-testable without a database (see tests/pagination.test.ts).

export const BROWSE_PAGE_SIZE = 30;
export const MAX_BROWSE_PAGE = 100;

/**
 * Parse a ?page= query value into a 1-based page number.
 * Missing, non-numeric, fractional, zero, or negative values fall back to page 1;
 * values above MAX_BROWSE_PAGE are clamped to it.
 */
export function parsePageParam(value: unknown): number {
  if (typeof value !== "string") return 1;
  const trimmed = value.trim();
  // Strictly positive integers only — no signs, decimals, exponents, or leading zeros.
  if (!/^[1-9]\d*$/.test(trimmed)) return 1;
  const page = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(page)) return 1;
  return Math.min(page, MAX_BROWSE_PAGE);
}

/** Build a /browse URL that preserves the current search query. Omits ?page= on page 1. */
export function browsePageUrl(page: number, q?: string): string {
  const params = new URLSearchParams();
  if (q && q.trim()) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/browse?${qs}` : "/browse";
}

/** Which prev/next links apply, given the current page and how many results came back. */
export function browsePageNav(currentPage: number, resultCount: number, pageSize: number = BROWSE_PAGE_SIZE): {
  hasPrev: boolean;
  hasNext: boolean;
} {
  return {
    hasPrev: currentPage > 1,
    // A full page means there is likely another one; a partial page means we hit the end.
    hasNext: resultCount >= pageSize,
  };
}
