import { describe, expect, it, vi } from "vitest";
import { CodexClient } from "../src/codex/client.js";
import { Logger } from "../src/logger.js";
import type { CodexThread } from "../src/types.js";

function thread(id: string): CodexThread {
  return {
    id,
    preview: id,
    name: id,
    cwd: `C:\\work\\${id}`,
    cliVersion: "0.1.0",
    updatedAt: 1,
    status: { type: "idle" },
  };
}

describe("CodexClient task listing", () => {
  it("follows every thread/list cursor instead of returning only the first page", async () => {
    const client = new CodexClient(new Logger(undefined, "error"));
    const request = vi.fn()
      .mockResolvedValueOnce({ data: [thread("one"), thread("two")], nextCursor: "page-2" })
      .mockResolvedValueOnce({ data: [thread("three")], nextCursor: null });
    Object.defineProperty(client, "request", { value: request });

    await expect(client.listAllThreads()).resolves.toEqual([
      thread("one"),
      thread("two"),
      thread("three"),
    ]);
    expect(request).toHaveBeenNthCalledWith(2, "thread/list", expect.objectContaining({
      cursor: "page-2",
    }));
  });
});
