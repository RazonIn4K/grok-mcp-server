import { GrokClient } from "../grok-client.js";

const baseUrl = process.argv[2];
if (!baseUrl) throw new Error("base URL argument is required");

const client = new GrokClient({
  apiKey: "test-key",
  baseUrl,
  model: "grok-test",
  temperature: 0.1,
  maxTokens: 32,
  minTimeMs: 0,
});

const request = {
  model: "grok-test",
  messages: [{ role: "user" as const, content: "cache this response" }],
};

await client.chatCompletion(request);
await client.chatCompletion(request);
await new Promise((resolve) => setTimeout(resolve, 100));
process.exit(0);
