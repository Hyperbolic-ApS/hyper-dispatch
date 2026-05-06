import { env } from "../config/env.js";
import type {
  JiraIssue,
  JiraBoardConfig,
  JiraField,
  JiraStatus,
  JiraTransitionsResponse,
} from "./types.js";

class JiraApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    message: string
  ) {
    super(message);
    this.name = "JiraApiError";
  }
}

function buildAuthHeader(): string {
  const credentials = `${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

async function jiraFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${env.JIRA_BASE_URL}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: buildAuthHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new JiraApiError(
      response.status,
      body,
      `Jira API error ${response.status} for ${path}: ${body}`
    );
  }

  // 204 No Content
  if (response.status === 204) {
    return undefined as unknown as T;
  }

  return response.json() as Promise<T>;
}

/**
 * Fetch a single Jira issue by key.
 * @param issueKey  e.g. "PROJ-123"
 * @param fields    optional list of field names to include in the response
 */
export async function getIssue(
  issueKey: string,
  fields?: string[]
): Promise<JiraIssue> {
  const params = fields?.length
    ? `?fields=${encodeURIComponent(fields.join(","))}`
    : "";
  return jiraFetch<JiraIssue>(`/rest/api/3/issue/${issueKey}${params}`);
}

/**
 * Fetch a Jira issue with the issuelinks field populated.
 */
export async function getIssueLinks(issueKey: string): Promise<JiraIssue> {
  return getIssue(issueKey, [
    "summary",
    "description",
    "status",
    "priority",
    "issuelinks",
  ]);
}

/**
 * Retrieve the available transitions for an issue.
 */
export async function getTransitions(
  issueKey: string
): Promise<JiraTransitionsResponse> {
  return jiraFetch<JiraTransitionsResponse>(
    `/rest/api/3/issue/${issueKey}/transitions`
  );
}

/**
 * Transition an issue to a new status using the given transitionId.
 */
export async function transitionIssue(
  issueKey: string,
  transitionId: string
): Promise<void> {
  await jiraFetch<void>(`/rest/api/3/issue/${issueKey}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: transitionId } }),
  });
}

/**
 * Fetch the board configuration for an Agile board.
 */
export async function getBoardConfig(boardId: number): Promise<JiraBoardConfig> {
  return jiraFetch<JiraBoardConfig>(
    `/rest/agile/1.0/board/${boardId}/configuration`
  );
}

/**
 * Fetch all fields defined in the Jira instance.
 */
export async function getFields(): Promise<JiraField[]> {
  return jiraFetch<JiraField[]>("/rest/api/3/field");
}

/**
 * Fetch all statuses defined in the Jira instance.
 */
export async function getStatuses(): Promise<JiraStatus[]> {
  return jiraFetch<JiraStatus[]>("/rest/api/3/status");
}
