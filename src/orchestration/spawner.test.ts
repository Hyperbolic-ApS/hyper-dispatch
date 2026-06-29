import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { makeJiraIssue, makeProjectConfig } from "../test/fixtures.js";
const {
  runMock,
  retrieveRunMock,
  ozApiConstructorMock,
  getTransitionsMock,
  transitionIssueMock,
  createRunMock,
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
  ozApiConstructorMock: vi.fn(),
  getTransitionsMock: vi.fn(),
  transitionIssueMock: vi.fn(),
  createRunMock: vi.fn(async () => ({ id: "run-record-1" })),
  updateRunStatusMock: vi.fn(),
}));

vi.mock("oz-agent-sdk", () => {
  return {
    default: class MockOzApi {
      constructor(options: unknown) {
        ozApiConstructorMock(options);
      }
      agent = { run: runMock, runs: { retrieve: retrieveRunMock } };
    },
  };
});

vi.mock("../config/env.js", () => ({
  env: {
    WARP_API_KEY: "test-key",
    JIRA_SITE_URL: "https://hyperbolic-co.atlassian.net",
  },
  resolveProjectTokens: (config: { github_pat?: string | null; jira_api_token?: string | null; oz_api_key?: string | null }) => ({
    githubToken: config.github_pat ?? "gh-test-key",
    jiraApiToken: config.jira_api_token ?? "jira-test-key",
    ozApiKey: config.oz_api_key ?? "test-key",
  }),
}));

vi.mock("../jira/client.js", () => ({
  getTransitions: getTransitionsMock,
  transitionIssue: transitionIssueMock,
}));

vi.mock("../db/queries.js", () => ({
  createRun: createRunMock,
  updateRunStatus: updateRunStatusMock,
}));

import {
  adfToText,
  buildPrompt,
  resolveModel,
  resolveRevisionModel,
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
  it("builds Jira-source-of-truth prompt with required lookup instructions", () => {
    const issue = makeJiraIssue({
      key: "HYDI-32",
      fields: {
        ...makeJiraIssue().fields,
        summary: "Summary only",
        description: undefined,
      },
    });

    expect(buildPrompt("HYDI-32", issue)).toBe(`Implement HYDI-32: Summary only
Branch name: agent/HYDI-32-summary-only
Use Jira as the source of truth for this task.
Ticket: HYDI-32
Jira URL: https://hyperbolic-co.atlassian.net/browse/HYDI-32
Before making code changes, use the available Jira tools to read the ticket and any related context needed to implement it. At minimum, fetch:
- Title/summary
- Description
- Direct subtasks, including the same fields listed here for each subtask
- Attachments (download contents when needed to understand or implement the ticket)
- Linked work items
- Comments
- Parent epic
Implement the feature described in the ticket. Do not rely on this prompt as the specification beyond identifying the ticket key and the required Jira lookup fields. If Jira context is unavailable, stop and report the blocker rather than guessing.
Follow the project worker instructions: use the branch name above, keep changes scoped to this ticket, add or update tests, run the required validation commands, commit, create a non-draft PR, and report the PR artifact.`);
  });

  it("does not embed ticket description in the prompt", () => {
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

    const prompt = buildPrompt("HYDI-32", issue);
    expect(prompt).toContain("Implement HYDI-32: With description");
    expect(prompt).toContain(
      "Jira URL: https://hyperbolic-co.atlassian.net/browse/HYDI-32"
    );
    expect(prompt).not.toContain("Single paragraph");
  });

  it("falls back to ticket-only branch name when summary slug normalizes to empty", () => {
    const issue = makeJiraIssue({
      fields: {
        ...makeJiraIssue().fields,
        summary: "!!!",
        description: undefined,
      },
    });

    expect(buildPrompt("HYDI-32", issue)).toContain(
      "Implement HYDI-32: !!!\nBranch name: agent/HYDI-32"
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

describe("resolveRevisionModel", () => {
  it("floors the reviser model at the review tier when base is unranked", () => {
    const issue = makeJiraIssue();
    const config = makeProjectConfig({ model_field_id: null, default_model: null });
    expect(
      resolveRevisionModel(issue, config, { floorTier: "auto", escalate: false })
    ).toBe("auto");
  });

  it("escalates one tier when a finding repeated", () => {
    const issue = makeJiraIssue();
    const config = makeProjectConfig({ model_field_id: null, default_model: null });
    // floorTier="auto-efficient" (rank 1) + escalate → rank 2 = "auto"
    expect(
      resolveRevisionModel(issue, config, { floorTier: "auto-efficient", escalate: true })
    ).toBe("auto");
  });

  it("never downgrades below the ticket/default model", () => {
    const issue = makeJiraIssue();
    const config = makeProjectConfig({ model_field_id: null, default_model: "auto-genius" });
    // base="auto-genius" (rank 3), floorTier="auto-open" (rank 0) → max = 3 → "auto-genius"
    expect(
      resolveRevisionModel(issue, config, { floorTier: "auto-open", escalate: false })
    ).toBe("auto-genius");
  });

  it("returns base unchanged when both base and floorTier are outside the tier list", () => {
    const issue = makeJiraIssue();
    const config = makeProjectConfig({ model_field_id: null, default_model: "claude-custom" });
    expect(
      resolveRevisionModel(issue, config, { floorTier: null, escalate: false })
    ).toBe("claude-custom");
  });

  it("caps escalation at auto-genius (the highest tier)", () => {
    const issue = makeJiraIssue();
    const config = makeProjectConfig({ model_field_id: null, default_model: "auto-genius" });
    expect(
      resolveRevisionModel(issue, config, { floorTier: "auto-genius", escalate: true })
    ).toBe("auto-genius");
  });

  it("returns custom base model unchanged when escalate=true (non-tier base not overridden)", () => {
    const issue = makeJiraIssue();
    const config = makeProjectConfig({ model_field_id: null, default_model: "claude-custom-model" });
    // escalate=true with a floorTier must not downgrade or override the custom non-tier base
    expect(
      resolveRevisionModel(issue, config, { floorTier: "auto-open", escalate: true })
    ).toBe("claude-custom-model");
  });
});

describe("spawnAgent", () => {
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    runMock.mockClear();
    retrieveRunMock.mockClear();
    ozApiConstructorMock.mockClear();
    getTransitionsMock.mockReset();
    transitionIssueMock.mockReset();
    createRunMock.mockReset();
    createRunMock.mockResolvedValue({ id: "run-record-1" });
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
      prompt: expect.stringContaining(
        "Implement HYDI-32: Implement tests\nBranch name: agent/HYDI-32-implement-tests"
      ),
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

  it("constructs Oz client with per-project oz_api_key when provided", async () => {
    getTransitionsMock.mockResolvedValue({ transitions: [] });
    const issue = makeJiraIssue();
    const config = makeProjectConfig({ oz_api_key: "project-oz-key" });

    await spawnAgent("HYDI-32", config, issue);

    expect(ozApiConstructorMock).toHaveBeenCalledWith({ apiKey: "project-oz-key" });
  });
});
