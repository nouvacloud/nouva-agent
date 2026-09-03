// @ts-expect-error Bun provides the test module at runtime in this workspace.
import { describe, expect, test } from "bun:test";
import {
  redactSensitiveText,
  sanitizeSensitiveProtocolValue,
  sanitizeSensitiveValue,
} from "./security.js";

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

  test("redacts environment names and values including one and two character secrets", () => {
    const redacted = redactSensitiveText("build-arg:Q=x build-arg:UV=yz", {
      Q: "x",
      UV: "yz",
    });

    for (const secret of ["Q", "x", "UV", "yz"]) {
      expect(redacted).not.toContain(secret);
    }
  });

  test("recursively sanitizes environment names and values in failure results", () => {
    const sanitized = sanitizeSensitiveValue(
      {
        Q: "x",
        nested: [
          {
            UV: "yz",
            statusMessage: "Q=x UV=yz",
          },
        ],
      },
      {
        Q: "x",
        UV: "yz",
      }
    );
    const serialized = JSON.stringify(sanitized);

    for (const secret of ["Q", "x", "UV", "yz"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("[REDACTED]");
  });

  test("redacts nested environment keys inside protocol values", () => {
    const sanitized = sanitizeSensitiveProtocolValue(
      {
        containerId: "container-runtime-secret",
        nested: {
          Q: "x",
          statusMessage: "Q=x",
        },
      },
      {
        runtimeMetadata: "runtime-secret",
        Q: "x",
      }
    );

    expect(sanitized).toEqual({
      containerId: "container-[REDACTED]",
      nested: {
        "[REDACTED]": "[REDACTED]",
        statusMessage: "[REDACTED]=[REDACTED]",
      },
    });
  });

  test("keeps payload operational paths that equal environment values", () => {
    const environmentVariables = {
      PGDATA: "/var/lib/postgresql/pgdata",
      Q: "x",
    };

    expect(
      sanitizeSensitiveProtocolValue(
        {
          dataPath: "/var/lib/postgresql/pgdata",
          statusMessage: "Q=x at /var/lib/postgresql/pgdata",
        },
        environmentVariables,
        ["/var/lib/postgresql/pgdata"]
      )
    ).toEqual({
      dataPath: "/var/lib/postgresql/pgdata",
      statusMessage: "[REDACTED]=[REDACTED] at /var/lib/postgresql/pgdata",
    });
    expect(
      sanitizeSensitiveProtocolValue(
        { dataPath: "/var/lib/postgresql/pgdata" },
        environmentVariables
      )
    ).toEqual({ dataPath: "[REDACTED]" });
  });
});
