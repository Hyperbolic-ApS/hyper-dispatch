import { env } from "../config/env.js";
import {
  type JiraColumnMappings,
  resolveJiraColumnMappings,
  jiraNamesEqual,
} from "../jira/columns.js";

export interface JiraCredentials {
  email: string;
  apiToken: string;
}

export interface ValidationCheck {
  name: string;
  passed: boolean;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  checks: ValidationCheck[];
}

function jiraAuthHeader(creds: JiraCredentials): string {
  const credentials = `${creds.email}:${creds.apiToken}`;
  return "Basic " + Buffer.from(credentials).toString("base64");
}

async function jiraFetch(path: string, creds: JiraCredentials): Promise<Response> {
  return fetch(`${env.JIRA_BASE_URL}${path}`, {
    headers: {
      Authorization: jiraAuthHeader(creds),
      Accept: "application/json",
    },
  });
}


export async function validateJiraProject(
  boardId: number,
  modelFieldId: string | null,
  columnMappings?: Partial<JiraColumnMappings>,
  credentials?: JiraCredentials
): Promise<ValidationResult> {
  const creds: JiraCredentials = credentials ?? {
    email: env.JIRA_EMAIL,
    apiToken: env.JIRA_API_TOKEN,
  };
  const checks: ValidationCheck[] = [];
  const resolvedMappings = resolveJiraColumnMappings(columnMappings);
  const requiredColumns = [
    resolvedMappings.backlog,
    resolvedMappings.toDo,
    resolvedMappings.inProgress,
    resolvedMappings.inReview,
    resolvedMappings.done,
  ];
  const requiredStatuses = [...requiredColumns];

  // Check 1: Board columns
  try {
    const res = await jiraFetch(`/rest/agile/1.0/board/${boardId}/configuration`, creds);
    if (!res.ok) {
      checks.push({
        name: "Board columns",
        passed: false,
        message: `Failed to fetch board configuration: ${res.status} ${res.statusText}`,
      });
    } else {
      const data = (await res.json()) as {
        columnConfig?: { columns?: Array<{ name: string }> };
      };
      const columns: string[] =
        data.columnConfig?.columns?.map((c) => c.name) ?? [];
      const missing = requiredColumns.filter(
        (req) => !columns.some((col) => jiraNamesEqual(col, req))
      );
      if (missing.length === 0) {
        checks.push({
          name: "Board columns",
          passed: true,
          message: `All required columns present: ${requiredColumns.join(", ")}`,
        });
      } else {
        checks.push({
          name: "Board columns",
          passed: false,
          message: `Missing columns: ${missing.join(", ")}. Found: ${columns.join(", ")}`,
        });
      }
    }
  } catch (err) {
    checks.push({
      name: "Board columns",
      passed: false,
      message: `Error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Check 2: Custom field (if model_field_id set)
  if (modelFieldId) {
    try {
      const res = await jiraFetch("/rest/api/3/field", creds);
      if (!res.ok) {
        checks.push({
          name: "Custom field",
          passed: false,
          message: `Failed to fetch fields: ${res.status} ${res.statusText}`,
        });
      } else {
        const fields = (await res.json()) as Array<{ id: string; name: string }>;
        const found = fields.find((f) => f.id === modelFieldId);
        if (found) {
          checks.push({
            name: "Custom field",
            passed: true,
            message: `Field "${modelFieldId}" found: ${found.name}`,
          });
        } else {
          checks.push({
            name: "Custom field",
            passed: false,
            message: `Field "${modelFieldId}" not found in project fields`,
          });
        }
      }
    } catch (err) {
      checks.push({
        name: "Custom field",
        passed: false,
        message: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    checks.push({
      name: "Custom field",
      passed: true,
      message: "No model_field_id configured — skipped",
    });
  }

  // Check 3: Workflow statuses
  try {
    const res = await jiraFetch("/rest/api/3/status", creds);
    if (!res.ok) {
      checks.push({
        name: "Workflow statuses",
        passed: false,
        message: `Failed to fetch statuses: ${res.status} ${res.statusText}`,
      });
    } else {
      const statuses = (await res.json()) as Array<{ name: string }>;
      const statusNames = statuses.map((s) => s.name);
      const missing = requiredStatuses.filter(
        (req) => !statusNames.some((s) => jiraNamesEqual(s, req))
      );
      if (missing.length === 0) {
        checks.push({
          name: "Workflow statuses",
          passed: true,
          message: `All required statuses present: ${requiredStatuses.join(", ")}`,
        });
      } else {
        checks.push({
          name: "Workflow statuses",
          passed: false,
          message: `Missing statuses: ${missing.join(", ")}`,
        });
      }
    }
  } catch (err) {
    checks.push({
      name: "Workflow statuses",
      passed: false,
      message: `Error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const valid = checks.every((c) => c.passed);
  return { valid, checks };
}
