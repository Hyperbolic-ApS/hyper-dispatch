import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { makeJiraIssue, makeProjectConfig } from "../test/fixtures.js";
const {
  runMock,
  retrieveRunMock,
  getTransitionsMock,
  transitionIssueMock,
  updateRunStatusMock,
} = vi.hoisted(() => ({
  runMock: vi.fn(async () => ({ run_id: "run_hydi_32", state: "QUEUED", task_id: "run_hydi_32" })),
  retrieveRunMock: vi.fn(async () => ({
    run_id: "run_hydi_32",
    state: "INPROGRESS",
    task_id: "run_hydi_32",
    title: "HYDI-32",
    prompt: "Implement HYDI-32",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    session_link: "https://oz.example/runs/run_hydi_32",
  })),
  getTransitionsMock: vi.fn(),
  transitionIssueMock: vi.fn(),
  updateRunStatusMock: vi.fn(),
}));

vi.mock("oz-agent-sdk", () => {
  return {
    default: class MockOzApi {
      agent = { run: runMock, runs: { retrieve: retrieveRunMock } };
    },
  };
});

vi.mock("../config/env.js", () => ({
  env: {
    WARP_API_KEY: "test-key",
  },
}));

vi.mock("../jira/client.js", () => ({
  getTransitions: getTransitionsMock,
  transitionIssue: transitionIssueMock,
}));

vi.mock("../db/queries.js", () => ({
  updateRunStatus: updateRunStatusMock,
}));

import {
  adfToText,
  buildPrompt,
  resolveModel,
  spawnAgent,
} from "./spawner.js";

describe("adfToText", () => {
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns leaf strings as-is", () => {
    expect(adfToText("hello")).toBe("hello");
  });

  it("returns text from a leaf text node", () => {
    expect(adfToText({ type: "text", text: "leaf text" })).toBe("leaf text");
  });

  it("returns empty string for null or undefined", () => {
    expect(adfToText(null)).toBe("");
    expect(adfToText(undefined)).toBe("");
  });

  it("returns empty string for an empty content array", () => {
    expect(adfToText({ type: "doc", content: [] })).toBe("");
  });

  it("handles deeply nested heading + paragraph + bulletList content", () => {
    const adf = {
      type: "doc",
      content: [
        { type: "heading", content: [{ type: "text", text: "Heading" }] },
        { type: "paragraph", content: [{ type: "text", text: "Paragraph" }] },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "One" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Two" }],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(adfToText(adf)).toBe("Heading\nParagraph\nOne Two");
  });

  it("handles mention, hardBreak, and codeBlock leaves", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", text: "@alice" },
            { type: "hardBreak" },
            { type: "text", text: "after-break" },
          ],
        },
        {
          type: "codeBlock",
          content: [{ type: "text", text: "const x = 1;" }],
        },
      ],
    };

    expect(adfToText(adf)).toBe("@alice  after-break\nconst x = 1;");
  });
});

describe("buildPrompt", () => {
  it("builds prompt from summary only when description is absent", () => {
    const issue = makeJiraIssue({
      key: "HYDI-32",
      fields: {
        ...makeJiraIssue().fields,
        summary: "Summary only",
        description: undefined,
      },
    });

    expect(buildPrompt("HYDI-32", issue)).toBe("Implement HYDI-32: Summary only");
  });

  it("builds prompt from summary and description", () => {
    const issue = makeJiraIssue({
      fields: {
        ...makeJiraIssue().fields,
        summary: "With description",
        description: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Single paragraph" }],
            },
          ],
        },
      },
    });

    expect(buildPrompt("HYDI-32", issue)).toBe(
      "Implement HYDI-32: With description\n\nSingle paragraph"
    );
  });

  it("handles multi-paragraph ADF descriptions", () => {
    const issue = makeJiraIssue({
      fields: {
        ...makeJiraIssue().fields,
        summary: "Multi paragraph",
        description: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Paragraph one" }],
            },
            {
              type: "paragraph",
              content: [{ type: "text", text: "Paragraph two" }],
            },
          ],
        },
      },
    });

    expect(buildPrompt("HYDI-32", issue)).toBe(
      "Implement HYDI-32: Multi paragraph\n\nParagraph one\nParagraph two"
    );
  });
});

describe("resolveModel", () => {
  it("uses non-empty string from custom model field", () => {
    const issue = makeJiraIssue({
      fields: {
        ...makeJiraIssue().fields,
        customfield_12345: " gpt-5 ",
      },
    });
    const config = makeProjectConfig({
      model_field_id: "customfield_12345",
      default_model: "default-model",
    });

    expect(resolveModel(issue, config)).toBe("gpt-5");
  });

  it("falls through when custom model field is whitespace", () => {
    const issue = makeJiraIssue({
      fields: {
        ...makeJiraIssue().fields,
        customfield_12345: "   ",
      },
    });
    const config = makeProjectConfig({
      model_field_id: "customfield_12345",
      default_model: "default-model",
    });

    expect(resolveModel(issue, config)).toBe("default-model");
  });

  it("uses object-shaped Jira custom field value when present", () => {
    const issue = makeJiraIssue({
      fields: {
        ...makeJiraIssue().fields,
        customfield_12345: { value: " claude-opus " },
      },
    });
    const config = makeProjectConfig({
      model_field_id: "customfield_12345",
      default_model: "default-model",
    });

    expect(resolveModel(issue, config)).toBe("claude-opus");
  });

  it("uses default_model when custom model field is not configured", () => {
    const issue = makeJiraIssue();
    const config = makeProjectConfig({
      model_field_id: null,
      default_model: "default-model",
    });

    expect(resolveModel(issue, config)).toBe("default-model");
  });

  it("returns undefined when no custom value and no default model", () => {
    const issue = makeJiraIssue();
    const config = makeProjectConfig({
      model_field_id: null,
      default_model: null,
    });

    expect(resolveModel(issue, config)).toBeUndefined();
  });
});

describe("spawnAgent", () => {
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    runMock.mockClear();
    retrieveRunMock.mockClear();
    getTransitionsMock.mockReset();
    transitionIssueMock.mockReset();
    updateRunStatusMock.mockReset();
  });

  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("spawns run, updates DB status, and transitions to In Progress when available", async () => {
    getTransitionsMock.mockResolvedValue({
      transitions: [{ id: "31", name: "In Progress" }],
    });

    const issue = makeJiraIssue({
      key: "HYDI-32",
      fields: {
        ...makeJiraIssue().fields,
        summary: "Implement tests",
      },
    });
    const config = makeProjectConfig({
      model_field_id: "customfield_12345",
      default_model: "default-model",
      skills: ["hyperdispatch-worker"],
      mcp_servers: { jira: { type: "stdio", command: "jira-mcp" } },
    });

    await spawnAgent("HYDI-32", config, issue);

    expect(runMock).toHaveBeenCalledWith({
      prompt: "Implement HYDI-32: Implement tests",
      config: expect.objectContaining({
        name: "HYDI-32",
        environment_id: config.oz_env_id,
        model_id: "default-model",
        skill_spec: "hyperdispatch-worker",
        mcp_servers: { jira: { type: "stdio", command: "jira-mcp" } },
      }),
    });
    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-32",
      expect.objectContaining({
        status: "running",
        run_id: "run_hydi_32",
        model: "default-model",
        spawned_at: expect.any(Date),
        session_link: "https://oz.example/runs/run_hydi_32",
      })
    );
    expect(retrieveRunMock).toHaveBeenCalledWith("run_hydi_32");
    expect(transitionIssueMock).toHaveBeenCalledWith("HYDI-32", "31");
  });

  it("skips transitionIssue when no matching In Progress transition exists", async () => {
    getTransitionsMock.mockResolvedValue({
      transitions: [{ id: "99", name: "Done" }],
    });
    const issue = makeJiraIssue();
    const config = makeProjectConfig();

    await spawnAgent("HYDI-32", config, issue);

    expect(getTransitionsMock).toHaveBeenCalledWith("HYDI-32");
    expect(transitionIssueMock).not.toHaveBeenCalled();
  });

  it("swallows transition errors and still completes spawn/update flow", async () => {
    getTransitionsMock.mockRejectedValue(new Error("jira unavailable"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const issue = makeJiraIssue();
    const config = makeProjectConfig();

    await spawnAgent("HYDI-32", config, issue);

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(updateRunStatusMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("continues when run detail lookup fails and stores null session link", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    retrieveRunMock.mockRejectedValueOnce(new Error("runs.retrieve unavailable"));
    getTransitionsMock.mockResolvedValue({ transitions: [] });
    const issue = makeJiraIssue();
    const config = makeProjectConfig();

    await spawnAgent("HYDI-32", config, issue);

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-32",
      expect.objectContaining({
        status: "running",
        session_link: null,
      })
    );
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("passes agent_identity_uid at the top level when configured", async () => {
    getTransitionsMock.mockResolvedValue({ transitions: [] });
    const issue = makeJiraIssue();
    const config = makeProjectConfig({
      oz_agent_identity_uid: "agent_identity_123",
    });

    await spawnAgent("HYDI-32", config, issue);

    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent_identity_uid: "agent_identity_123" })
    );
  });

  it("omits agent_identity_uid when not configured", async () => {
    getTransitionsMock.mockResolvedValue({ transitions: [] });
    const issue = makeJiraIssue();
    const config = makeProjectConfig({ oz_agent_identity_uid: null });

    await spawnAgent("HYDI-32", config, issue);

    expect(runMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ agent_identity_uid: expect.anything() })
    );
  });
});
