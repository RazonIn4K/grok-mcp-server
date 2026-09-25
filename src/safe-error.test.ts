import { describe, expect, it } from "vitest";
import { redactSecrets, toSafeError } from "./safe-error.js";

describe("safe error logging", () => {
  it("redacts bearer and xAI credentials from messages", () => {
    const message =
      "request failed with Bearer abc.def-123 and key xai-super-secret";

    expect(redactSecrets(message)).toBe(
      "request failed with [REDACTED] and key [REDACTED]",
    );
  });

  it("keeps useful error metadata without serializing request config", () => {
    const error = Object.assign(
      new Error("timeout for Bearer secret-token"),
      {
        code: "ECONNABORTED",
        response: { status: 504 },
        config: {
          headers: { Authorization: "Bearer should-never-appear" },
        },
      },
    );

    const safe = toSafeError(error);

    expect(safe).toEqual({
      name: "Error",
      message: "timeout for [REDACTED]",
      code: "ECONNABORTED",
      status: 504,
    });
    expect(JSON.stringify(safe)).not.toContain("should-never-appear");
    expect(JSON.stringify(safe)).not.toContain("Authorization");
  });

  it("redacts credentials embedded in URLs and key-value error text", () => {
    const message =
      "GET https://provider.test/models?api_key=url-secret&mode=safe password=body-secret";

    const safe = redactSecrets(message);

    expect(safe).not.toContain("url-secret");
    expect(safe).not.toContain("body-secret");
    expect(safe).toContain("mode=safe");
  });

  it.each([
    "api_key",
    "api-key",
    "token",
    "access_token",
    "access-token",
    "secret",
    "password",
    "authorization",
  ])("redacts JSON-quoted %s fields in provider error messages", (field) => {
    const message = JSON.stringify({
      [field]: "fake credential with spaces & an escaped \"quote\"",
      operation: "chat",
    });

    const safe = toSafeError(new Error(message));

    expect(safe.message).not.toContain("fake");
    expect(safe.message).not.toContain("credential");
    expect(safe.message).not.toContain("escaped");
    expect(safe.message).not.toContain("quote");
    expect(safe.message).toContain("[REDACTED]");
    expect(safe.message).toContain('"operation":"chat"');
  });

  it("redacts single-quoted keys and values without exposing trailing words", () => {
    const safe = redactSecrets("'password': 'fake secret with spaces' operation=chat");

    expect(safe).not.toContain("fake");
    expect(safe).not.toContain("spaces");
    expect(safe).toContain("operation=chat");
  });
});
