import { afterAll, describe, expect, it } from "vitest";
import { CodexClient } from "../src/codex/client.js";
import { Logger } from "../src/logger.js";

const enabled = process.env.RUN_CODEX_INTEGRATION === "1";
const client = new CodexClient(new Logger(undefined, "error"));

describe.skipIf(!enabled)("Codex app-server integration", () => {
  afterAll(async () => client.stop());

  it("lists and searches persisted desktop threads", async () => {
    await client.start();
    const recent = await client.listThreads(5);
    expect(recent.length).toBeGreaterThan(0);
    const query = `${recent[0].name ?? ""} ${recent[0].preview}`.match(/[A-Za-z0-9_-]{3,}/)?.[0]
      ?? recent[0].preview.slice(0, 2);
    const results = await client.searchThreads(query, 5);
    expect(results.some((result) => result.thread.id === recent[0].id)).toBe(true);
  }, 30_000);
});
