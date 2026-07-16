// @ts-expect-error Bun provides the test module at runtime in this workspace.
import { describe, expect, test } from "bun:test";
import { redactSensitiveText } from "./security.js";

describe("redactSensitiveText", () => {
  test("redacts clone credentials from command failures", () => {
    expect(
      redactSensitiveText(
        "Command failed: git clone https://x-access-token:ghs_installation_secret@github.com/nouva/private.git"
      )
    ).toBe("Command failed: git clone https://[REDACTED]@github.com/nouva/private.git");
  });

  test("leaves ordinary build failures unchanged", () => {
    expect(redactSensitiveText("Docker build failed")).toBe("Docker build failed");
  });
});
