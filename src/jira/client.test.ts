import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as jira from "./client.js";

describe("getIssuesByKeys", () => {
  // Matches the fetch-spy typing used in monitor.test.ts; the global fetch overloads
  // do not unify cleanly with vi.spyOn's generic signature.
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns an empty array without calling fetch for no keys", async () => {
    const result = await jira.getIssuesByKeys([]);
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("chunks more than 100 keys into batches of at most 100 and flattens results", async () => {
    const keys = Array.from({ length: 250 }, (_, i) => `HYDI-${i + 1}`);
    fetchSpy.mockImplementation(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as RequestInit).body as string) as {
        issueIdsOrKeys: string[];
      };
      const issues = body.issueIdsOrKeys.map((key) => ({
        key,
        fields: { status: { name: "To Do" } },
      }));
      return new Response(JSON.stringify({ issues }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await jira.getIssuesByKeys(keys);

    // 250 keys -> 100 + 100 + 50 == three POSTs to the bulkfetch endpoint.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const batchSizes = fetchSpy.mock.calls.map(
      (call: unknown[]) =>
        (JSON.parse((call[1] as RequestInit).body as string) as {
          issueIdsOrKeys: string[];
        }).issueIdsOrKeys.length
    );
    expect(batchSizes).toEqual([100, 100, 50]);
    expect(result).toHaveLength(250);
    expect(result.map((issue) => issue.key)).toEqual(keys);

    const [firstUrl, firstInit] = fetchSpy.mock.calls[0];
    expect(String(firstUrl)).toContain("/rest/api/3/issue/bulkfetch");
    expect((firstInit as RequestInit).method).toBe("POST");
  });

  it("requests only the status field by default", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ issues: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    await jira.getIssuesByKeys(["HYDI-1"]);

    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string
    ) as { fields: string[] };
    expect(body.fields).toEqual(["status"]);
  });
});
