import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

describe("stdio-safe Grok client logging", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("keeps production cache logs off stdout", async () => {
    const api = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "chat-test",
          object: "chat.completion",
          created: 1,
          model: "grok-test",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const address = api.address();
    if (!address || typeof address === "string") throw new Error("test API did not bind a TCP port");

    const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const child = spawn(
      join(repoRoot, "node_modules", ".bin", "tsx"),
      [join(repoRoot, "src", "test-fixtures", "stdio-client-logger.ts"), `http://127.0.0.1:${address.port}`],
      {
        cwd: repoRoot,
        env: { ...process.env, NODE_ENV: "production" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const [exitCode] = (await once(child, "exit")) as [number | null];
    api.close();
    await once(api, "close");

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("Cache hit for chatCompletion");
    expect(stderr).not.toContain("cache this response");
  });
});
