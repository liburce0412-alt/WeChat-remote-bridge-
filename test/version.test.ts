import { describe, expect, it } from "vitest";
import { compareCodexVersions } from "../src/codex/client.js";

describe("compareCodexVersions", () => {
  it("allows an older task to resume on a newer bridge runtime", () => {
    expect(compareCodexVersions("0.145.0-alpha.27", "0.146.0-alpha.3.1")).toBe(-1);
  });

  it("detects a task created by a newer runtime", () => {
    expect(compareCodexVersions("0.146.0-alpha.3.1", "0.145.0-alpha.27")).toBe(1);
  });

  it("compares prerelease identifiers and equal versions", () => {
    expect(compareCodexVersions("0.146.0-alpha.27", "0.146.0-alpha.3.1")).toBe(1);
    expect(compareCodexVersions("0.146.0-alpha.3.1", "0.146.0-alpha.3.1")).toBe(0);
  });
});
