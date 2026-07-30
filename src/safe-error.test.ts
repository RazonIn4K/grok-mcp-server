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
});
