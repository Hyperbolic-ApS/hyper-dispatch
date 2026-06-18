import { env } from "../config/env.js";
import type {
  JiraIssue,
  JiraField,
  JiraStatus,
  JiraSearchResponse,
  JiraBulkFetchResponse,
  JiraTransitionsResponse,
} from "./types.js";
export class JiraApiError extends Error {
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
  return `Bearer ${env.JIRA_API_TOKEN}`;
}

function buildBaseUrl(): string {
  return `https://api.atlassian.com/ex/jira/${env.JIRA_CLOUD_ID}`;
}

async function jiraFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${buildBaseUrl()}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: buildAuthHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Language": "en",
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
 * Maximum number of issue keys accepted by POST /rest/api/3/issue/bulkfetch per request.
 */
const BULK_FETCH_MAX_KEYS = 100;

/**
 * Fetch many Jira issues in a single bulk operation, chunked to the API's 100-key limit.
 *
 * Unlike a JQL `key IN (...)` query (which fails the whole request if any key no longer
 * exists), bulkfetch tolerates missing/inaccessible keys by omitting them from `issues`
 * (and reporting them under `issueErrors`). Callers can therefore treat a key's absence
 * from the returned list as "not found" without issuing one request per key.
 *
 * @param issueKeys  Issue keys (or IDs) to fetch.
 * @param fields     Fields to include per issue (defaults to status only).
 */
export async function getIssuesByKeys(
  issueKeys: string[],
  fields: string[] = ["status"]
): Promise<JiraIssue[]> {
  if (issueKeys.length === 0) return [];

  const issues: JiraIssue[] = [];
  for (let start = 0; start < issueKeys.length; start += BULK_FETCH_MAX_KEYS) {
    const batch = issueKeys.slice(start, start + BULK_FETCH_MAX_KEYS);
    const page = await jiraFetch<JiraBulkFetchResponse>(
      "/rest/api/3/issue/bulkfetch",
      {
        method: "POST",
        body: JSON.stringify({ issueIdsOrKeys: batch, fields }),
      }
    );
    issues.push(...(page.issues ?? []));
  }
  return issues;
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

function escapeJqlValue(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Find issues for a Jira project currently in the provided status name.
 */
export async function searchIssuesInStatus(
  projectKey: string,
  statusName: string,
  fields: string[] = ["summary", "priority", "status"]
): Promise<JiraIssue[]> {
  const jql = `project = "${escapeJqlValue(projectKey)}" AND status = "${escapeJqlValue(statusName)}"`;
  const pageSize = 100;
  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;

  while (true) {
    const page = await jiraFetch<JiraSearchResponse>("/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify({
        jql,
        maxResults: pageSize,
        fields,
        ...(nextPageToken ? { nextPageToken } : {}),
      }),
    });

    issues.push(...page.issues);
    if (!page.nextPageToken) break;
    nextPageToken = page.nextPageToken;
  }

  return issues;
}

/**
 * Add a plain-text comment to a Jira issue using Atlassian Document Format.
 */
export async function addCommentToIssue(
  issueKey: string,
  comment: string
): Promise<void> {
  await jiraFetch<void>(`/rest/api/3/issue/${issueKey}/comment`, {
    method: "POST",
    body: JSON.stringify({
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: comment }],
          },
        ],
      },
    }),
  });
}
