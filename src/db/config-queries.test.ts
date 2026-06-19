import { beforeEach, describe, expect, it, vi } from "vitest";

const beginMock = vi.fn();

// Mock only the connection boundary so deleteProjectConfig runs against a fake
// transaction. This keeps the test offline (no Postgres) while still asserting
// that both deletes are issued through a single sql.begin() transaction.
vi.mock("./connection.js", () => ({
  sql: {
    begin: (callback: (tx: unknown) => Promise<unknown>) => beginMock(callback),
  },
}));

// Builds a fake transaction tag that records the SQL it is asked to run and can
// optionally reject for statements matching `failOn` (to simulate a DB error).
function createTxRecorder(failOn?: RegExp) {
  const statements: string[] = [];
  const tx = (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    const text = strings
      .reduce(
        (acc, part, index) => acc + part + (index < values.length ? "?" : ""),
        ""
      )
      .replace(/\s+/g, " ")
      .trim();
    statements.push(text);
    if (failOn && failOn.test(text)) {
      return Promise.reject(
        new Error("simulated failure on project_configs delete")
      );
    }
    return Promise.resolve([]);
  };
  return { statements, tx };
}

describe("deleteProjectConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes dispatch_runs then project_configs inside a single transaction", async () => {
    const { deleteProjectConfig } = await import("./config-queries.js");
    const recorder = createTxRecorder();
    beginMock.mockImplementation(
      (callback: (tx: unknown) => Promise<unknown>) => callback(recorder.tx)
    );

    await deleteProjectConfig("HYDI");

    expect(beginMock).toHaveBeenCalledTimes(1);
    expect(recorder.statements).toHaveLength(2);
    expect(recorder.statements[0]).toContain("DELETE FROM dispatch_entries");
    expect(recorder.statements[1]).toContain("DELETE FROM project_configs");
  });

  it("propagates the error so the transaction rolls back when the project_configs delete fails", async () => {
    const { deleteProjectConfig } = await import("./config-queries.js");
    const recorder = createTxRecorder(/project_configs/);
    beginMock.mockImplementation(
      (callback: (tx: unknown) => Promise<unknown>) => callback(recorder.tx)
    );

    await expect(deleteProjectConfig("HYDI")).rejects.toThrow(
      "simulated failure on project_configs delete"
    );

    // The dispatch_entries delete is issued inside the same begin() callback, so a
    // real transaction rolls it back when the second statement throws — the
    // run history is never destroyed on a partial failure.
    expect(beginMock).toHaveBeenCalledTimes(1);
    expect(recorder.statements[0]).toContain("DELETE FROM dispatch_entries");
  });
});
