import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const SEARCH_URL = "https://api.firecrawl.dev/v2/search";
const SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
const MAX_QUERY_LENGTH = 300;
const MAX_FETCH_CHARS = 12000;

function ipv4Parts(address: string) {
  const parts = address.split(".").map((part) => Number(part));
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function isPublicIpv4(address: string) {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function mappedIpv4(address: string) {
  const lower = address.toLowerCase();
  if (!lower.startsWith("::ffff:")) return null;
  const suffix = lower.slice("::ffff:".length);
  if (ipv4Parts(suffix)) return suffix;
  const hex = suffix.split(":");
  if (hex.length !== 2) return null;
  const high = Number.parseInt(hex[0], 16);
  const low = Number.parseInt(hex[1], 16);
  if (!Number.isInteger(high) || !Number.isInteger(low) || high < 0 || high > 0xffff || low < 0 || low > 0xffff) return null;
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isPublicIp(address: string) {
  const normalized = address.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (isIP(normalized) === 4) return isPublicIpv4(normalized);
  if (isIP(normalized) !== 6) return false;
  const embedded = mappedIpv4(normalized);
  if (embedded) return isPublicIpv4(embedded);
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
  if (/^fe[89ab][0-9a-f]?:/i.test(normalized)) return false;
  if (normalized.startsWith("ff")) return false;
  const firstHextet = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  if (!Number.isInteger(firstHextet) || firstHextet < 0x2000 || firstHextet > 0x3fff) return false;
  if (normalized.startsWith("2001:0:") || normalized.startsWith("2001:2:") || normalized.startsWith("2001:db8:")) return false;
  return true;
}

function parsePublicHttpUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const hostname = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return null;
  if (isIP(hostname) && !isPublicIp(hostname)) return null;
  return { url, hostname };
}

export async function isPublicHttpUrl(value: string) {
  const parsed = parsePublicHttpUrl(value);
  if (!parsed) return false;
  if (isIP(parsed.hostname)) return true;
  try {
    const records = await lookup(parsed.hostname, { all: true, verbatim: true });
    return records.length > 0 && records.every((record) => isPublicIp(record.address));
  } catch {
    return false;
  }
}

function missingKey() {
  return { ok: false as const, message: "Web access is not configured for this workspace." };
}

export async function firecrawlSearch(input: { query: string; limit?: number }) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return missingKey();
  const query = input.query.trim().slice(0, MAX_QUERY_LENGTH);
  if (!query) return { ok: false as const, message: "Search query is required." };
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 5), 1), 5);
  try {
    const response = await fetch(SEARCH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return { ok: false as const, message: "Web search is unavailable right now." };
    const json = await response.json() as { data?: Array<{ title?: string; url?: string; description?: string }> };
    const checked = await Promise.all((json.data ?? []).map(async (item) => {
      if (!item.url || !(await isPublicHttpUrl(item.url))) return null;
      return { title: (item.title ?? item.url).slice(0, 160), url: item.url, description: (item.description ?? "").slice(0, 300) };
    }));
    const results = checked.filter((item): item is NonNullable<typeof item> => item !== null).slice(0, limit);
    return { ok: true as const, results };
  } catch {
    return { ok: false as const, message: "Web search is unavailable right now." };
  }
}

export async function firecrawlFetch(input: { url: string }) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return missingKey();
  if (!(await isPublicHttpUrl(input.url))) return { ok: false as const, message: "That URL cannot be fetched." };
  try {
    const response = await fetch(SCRAPE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: input.url, formats: ["markdown"], onlyMainContent: true, timeout: 12000 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { ok: false as const, message: "That page could not be fetched right now." };
    const json = await response.json() as { data?: { title?: string; markdown?: string; url?: string; metadata?: { title?: string } } };
    const data = json.data;
    const markdown = data?.markdown?.trim();
    if (!markdown) return { ok: false as const, message: "No readable page content was found." };
    return {
      ok: true as const,
      page: {
        title: (data?.title ?? data?.metadata?.title ?? input.url).slice(0, 160),
        url: data?.url ?? input.url,
        markdown: markdown.slice(0, MAX_FETCH_CHARS),
        truncated: markdown.length > MAX_FETCH_CHARS,
      },
    };
  } catch {
    return { ok: false as const, message: "That page could not be fetched right now." };
  }
}
