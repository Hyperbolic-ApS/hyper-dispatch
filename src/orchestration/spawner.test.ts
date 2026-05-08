import { describe, expect, it, vi } from "vitest";
import {
  makeJiraIssue,
  makeProjectConfig,
} from "../test/fixtures.js";

const updateRunStatusMock = vi.fn();
const getTransitionsMock = vi.fn();
const transitionIssueMock = vi.fn();
const ozRunMock = vi.fn();

vi.mock("../db/queries.js", () => ({
  updateRunStatus: updateRunStatusMock,
}));

vi.mock("../jira/client.js", () => ({
  getTransitions: getTransitionsMock,
  transitionIssue: transitionIssueMock,
}));

vi.mock("oz-agent-sdk", () => ({
  default: class MockOzApi {
    agent = {
      run: ozRunMock,
    };
  },
}));

describe("spawnAgent", () => {
  it("starts an Oz run and updates dispatch run status", async () => {
    ozRunMock.mockResolvedValue({ run_id: "run_100" });
    getTransitionsMock.mockResolvedValue({ transitions: [] });
    const config = makeProjectConfig({
      model_field_id: "customfield_model",
      default_model: "auto",
      skills: ["owner/repo:hyperdispatch-worker"],
      mcp_servers: { foo: { command: "echo" } },
    });
    const issue = makeJiraIssue({
      fields: {
        ...makeJiraIssue().fields,
        customfield_model: "claude-sonnet-4-5",
      },
    });

    const { spawnAgent } = await import("./spawner.js");
    await spawnAgent("HYDI-99", config, issue);

    expect(ozRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Implement HYDI-99"),
        config: expect.objectContaining({
          name: "HYDI-99",
          model_id: "claude-sonnet-4-5",
          skill_spec: "owner/repo:hyperdispatch-worker",
        }),
      })
    );
    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-99",
      expect.objectContaining({
        status: "running",
        run_id: "run_100",
        model: "claude-sonnet-4-5",
      })
    );
  });

  it("uses default model and transitions Jira to in-progress when available", async () => {
    ozRunMock.mockResolvedValue({ run_id: "run_200" });
    getTransitionsMock.mockResolvedValue({
      transitions: [{ id: "12", name: "In Progress" }],
    });
    const config = makeProjectConfig({ default_model: "auto" });

    const { spawnAgent } = await import("./spawner.js");
    await spawnAgent("HYDI-200", config, makeJiraIssue());

    expect(ozRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          model_id: "auto",
        }),
      })
    );
    expect(transitionIssueMock).toHaveBeenCalledWith("HYDI-200", "12");
  });

  it("falls back cleanly when Jira transition lookup fails", async () => {
    ozRunMock.mockResolvedValue({ run_id: "run_300" });
    getTransitionsMock.mockRejectedValue(new Error("jira unavailable"));
    const config = makeProjectConfig();
    const { spawnAgent } = await import("./spawner.js");

    await expect(spawnAgent("HYDI-300", config, makeJiraIssue())).resolves.toBeUndefined();
    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-300",
      expect.objectContaining({
        status: "running",
      })
    );
  });
});
