export interface SearchCitation {
  title: string;
  url: string;
  snippet: string;
  published_date?: string;
  source?: string;
}

const INLINE_CITATION_RE = /\[\[(\d+)\]\]\((https?:\/\/[^\s)]+)\)/g;
const IMAGE_MARKDOWN_RE = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
const LINK_MARKDOWN_RE = /(?<!!)\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

export function isNumericLabel(value?: string): boolean {
  return Boolean(value && /^\d+$/.test(value.trim()));
}

export function deriveSearchTitle(url: string, rawTitle?: string): string {
  const cleaned = rawTitle?.trim();
  if (cleaned && !isNumericLabel(cleaned) && cleaned !== url) {
    return cleaned;
  }

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const parts = parsed.pathname.split("/").filter(Boolean);

    if (host === "x.com" || host === "twitter.com") {
      if (parts[0] && parts[1] === "status") {
        return `@${parts[0]}`;
      }
      if (parts[0] === "i" && parts[1] === "status") {
        return "X post";
      }
      if (parts[0] === "i" && parts[1] === "user") {
        return "X user";
      }
      return parts[0] ? `X · @${parts[0]}` : "X";
    }

    const last = parts.at(-1);
    if (last) {
      const pretty = decodeURIComponent(last)
        .replace(/\.[a-z0-9]{1,8}$/i, "")
        .replace(/(\d+)-(\d+)/g, "$1.$2")
        .replace(/[-_]+/g, " ")
        .trim();
      if (pretty && pretty.toLowerCase() !== "index") {
        return `${pretty} (${host})`;
      }
    }
    return host || url;
  } catch {
    return cleaned || url;
  }
}

export function extractSearchSummary(data: any): string {
  const parts: string[] = [];

  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    parts.push(data.output_text.trim());
  }

  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    // Grok 4.7 always includes reasoning items in Responses API output. Only
    // assistant messages are the final answer; tool/reasoning content is not.
    // Accept missing discriminators for older compatible response formats.
    if (
      (item?.type && item.type !== "message") ||
      (item?.role && item.role !== "assistant")
    ) {
      continue;
    }
    if (!Array.isArray(item?.content)) {
      continue;
    }
    for (const part of item.content) {
      if (typeof part === "string" && part.trim()) {
        parts.push(part.trim());
        continue;
      }
      if (part?.type === "output_text" && typeof part.text === "string") {
        parts.push(part.text.trim());
      } else if (typeof part?.content === "string" && part.content.trim()) {
        parts.push(part.content.trim());
      } else if (typeof part?.text === "string" && part.text.trim()) {
        parts.push(part.text.trim());
      }
    }
  }

  return Array.from(new Set(parts.filter(Boolean))).join("\n\n");
}

function collectRawCitations(data: any): any[] {
  const citations: any[] = [];
  const seen = new Set<string>();

  const pushUnique = (value: any) => {
    const key =
      typeof value === "string"
        ? value
        : value?.url || value?.link || JSON.stringify(value);
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    citations.push(value);
  };

  if (Array.isArray(data?.citations)) {
    data.citations.forEach(pushUnique);
  }
  if (Array.isArray(data?.annotations)) {
    data.annotations.forEach(pushUnique);
  }

  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    if (item?.type === "reasoning") {
      continue;
    }
    if (Array.isArray(item?.citations)) {
      item.citations.forEach(pushUnique);
    }

    const toolResults =
      item?.results ||
      item?.sources ||
      item?.action?.sources ||
      item?.action?.results;
    if (Array.isArray(toolResults)) {
      toolResults.forEach(pushUnique);
    }

    if (!Array.isArray(item?.content)) {
      continue;
    }
    for (const part of item.content) {
      if (Array.isArray(part?.citations)) {
        part.citations.forEach(pushUnique);
      }
      if (Array.isArray(part?.metadata?.citations)) {
        part.metadata.citations.forEach(pushUnique);
      }
      if (Array.isArray(part?.annotations)) {
        part.annotations.forEach(pushUnique);
      }
    }
  }

  return citations;
}

export function extractInlineSources(text: string): SearchCitation[] {
  const results: SearchCitation[] = [];
  const seen = new Set<string>();

  const add = (title: string, url: string, source?: string) => {
    if (!url || seen.has(url)) {
      return;
    }
    seen.add(url);
    results.push({
      title: deriveSearchTitle(url, title),
      url,
      snippet: "",
      source,
    });
  };

  for (const match of text.matchAll(INLINE_CITATION_RE)) {
    add(match[1], match[2]);
  }
  for (const match of text.matchAll(IMAGE_MARKDOWN_RE)) {
    add(match[1] || "Image result", match[2], "image");
  }
  for (const match of text.matchAll(LINK_MARKDOWN_RE)) {
    if (match[1].startsWith("[")) {
      continue;
    }
    add(match[1], match[2]);
  }

  return results;
}

function snippetNearUrl(text: string, url: string): string {
  if (!text || !url) {
    return "";
  }

  const citationMatch = text.match(
    new RegExp(`.{0,180}\\[\\[\\d+\\]\\]\\(${escapeRegExp(url)}\\)`),
  );
  if (citationMatch?.[0]) {
    return citationMatch[0].replace(/\s+/g, " ").trim();
  }

  const index = text.indexOf(url);
  if (index >= 0) {
    const start = Math.max(0, index - 120);
    return text.slice(start, index + url.length).replace(/\s+/g, " ").trim();
  }

  return "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildSearchResults(
  data: any,
  query: string,
  maxResults: number,
): { summary: string; results: SearchCitation[] } {
  const summary = extractSearchSummary(data);
  const seenUrls = new Set<string>();
  const results: SearchCitation[] = [];

  const addResult = (candidate: Partial<SearchCitation> & { url?: string }) => {
    const url = candidate.url?.trim();
    if (!url || seenUrls.has(url)) {
      return;
    }
    seenUrls.add(url);
    const snippet =
      candidate.snippet?.trim() && candidate.snippet.trim() !== summary
        ? candidate.snippet.trim()
        : snippetNearUrl(summary, url);
    results.push({
      title: deriveSearchTitle(url, candidate.title),
      url,
      snippet: snippet.slice(0, 280),
      published_date: candidate.published_date,
      source: candidate.source,
    });
  };

  for (const citation of collectRawCitations(data)) {
    if (typeof citation === "string") {
      addResult({ url: citation });
      continue;
    }
    const url = citation.url || citation.link || citation.href;
    if (!url) {
      continue;
    }
    addResult({
      title: citation.title || citation.name,
      url,
      snippet: citation.snippet || citation.text || citation.description,
      published_date: citation.published_date,
      source: citation.source,
    });
  }

  for (const inline of extractInlineSources(summary)) {
    addResult(inline);
  }

  if (results.length === 0 && summary && !/^no (?:matching )?results? (?:were )?found\b/i.test(summary)) {
    results.push({
      title: `Search summary for: ${query}`,
      url: "",
      snippet: summary.substring(0, 500) + (summary.length > 500 ? "..." : ""),
      source: "model_summary",
    });
  }

  return {
    summary,
    results: results.slice(0, maxResults),
  };
}

export function supportsResponsesReasoning(model: string): boolean {
  return (
    model.startsWith("grok-4.7") ||
    model.startsWith("grok-4.6") ||
    model.startsWith("grok-4.5") ||
    model.startsWith("grok-4.3")
  );
}
