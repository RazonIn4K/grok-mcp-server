import { describe, expect, it } from "vitest";
import {
  buildSearchResults,
  deriveSearchTitle,
  extractInlineSources,
  extractSearchSummary,
  supportsResponsesReasoning,
} from "./search-results.js";

describe("deriveSearchTitle", () => {
  it("keeps a real title and ignores numeric citation labels", () => {
    expect(deriveSearchTitle("https://x.ai/news/grok-4-6", "Introducing Grok 4.6")).toBe(
      "Introducing Grok 4.6",
    );
    expect(deriveSearchTitle("https://x.ai/news/grok-4-6", "1")).toBe("grok 4.6 (x.ai)");
  });

  it("derives X handles from status URLs", () => {
    expect(deriveSearchTitle("https://x.com/grok/status/123")).toBe("@grok");
  });
});

describe("extractSearchSummary and inline sources", () => {
  it("reads output_text and markdown citations", () => {
    const data = {
      output_text: "Official launch.[[1]](https://x.ai/news/grok-4-6)",
      output: [],
    };
    expect(extractSearchSummary(data)).toContain("Official launch");
    expect(extractInlineSources(extractSearchSummary(data))[0].url).toBe(
      "https://x.ai/news/grok-4-6",
    );
  });

  it("extracts only assistant text alongside encrypted reasoning and tool output", () => {
    const data = {
      output: [
        {
          type: "reasoning",
          encrypted_content: "opaque-encrypted-reasoning",
          content: [{ type: "reasoning_text", text: "Reasoning is not the answer." }],
          summary: [{ type: "summary_text", text: "A reasoning summary." }],
        },
        {
          type: "web_search_call",
          content: [{ text: "Tool diagnostics are not the answer." }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "The final cited answer." }],
        },
      ],
    };

    expect(extractSearchSummary(data)).toBe("The final cited answer.");
  });
});

describe("buildSearchResults", () => {
  it("ignores reasoning citations while retaining final message and search sources", () => {
    const { summary, results } = buildSearchResults({
      output: [
        {
          type: "reasoning",
          encrypted_content: "opaque-encrypted-reasoning",
          content: [{
            type: "reasoning_text",
            text: "Internal candidate source.",
            annotations: [{ url: "https://example.com/candidate" }],
          }],
        },
        {
          type: "web_search_call",
          action: { sources: [{ url: "https://example.com/source", title: "Source" }] },
        },
        {
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text: "Final answer.",
            annotations: [{ url: "https://example.com/cited", title: "Cited" }],
          }],
        },
      ],
    }, "query", 5);

    expect(summary).toBe("Final answer.");
    expect(results.map((result) => result.url)).toEqual([
      "https://example.com/source",
      "https://example.com/cited",
    ]);
  });

  it("prefers unique source titles over duplicated summary snippets", () => {
    const { summary, results } = buildSearchResults(
      {
        citations: [
          "https://x.ai/news/grok-4-6",
          "https://docs.x.ai/developers/grok-4-6",
        ],
        output: [
          {
            content: [
              {
                type: "output_text",
                text: "Grok 4.6 shipped August 12, 2026.[[1]](https://x.ai/news/grok-4-6) API docs list the model id.[[2]](https://docs.x.ai/developers/grok-4-6)",
                annotations: [
                  { url: "https://x.ai/news/grok-4-6", title: "1" },
                  { url: "https://docs.x.ai/developers/grok-4-6", title: "2" },
                ],
              },
            ],
          },
        ],
      },
      "Grok 4.6",
      5,
    );

    expect(summary).toContain("August 12, 2026");
    expect(results).toHaveLength(2);
    expect(results[0].title).not.toBe("1");
    expect(results[1].title).not.toBe("2");
    expect(results.every((item) => item.url.startsWith("https://"))).toBe(true);
  });
});

describe("supportsResponsesReasoning", () => {
  it.each(["grok-4.7", "grok-4.6", "grok-4.5", "grok-4.3"])(
    "enables low-effort reasoning for %s search", (model) => {
      expect(supportsResponsesReasoning(model)).toBe(true);
  });

  it("omits effort for model-selected reasoning modes", () => {
    expect(supportsResponsesReasoning("grok-4.20-0309-non-reasoning")).toBe(false);
    expect(supportsResponsesReasoning("grok-4.20-0309-reasoning")).toBe(false);
  });
});
