import { env } from "../config/env.js";
import {
  type JiraColumnMappings,
  resolveJiraColumnMappings,
  jiraNamesEqual,
} from "../jira/columns.js";

export interface JiraCredentials {
  cloudId: string;
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

async function jiraFetch(path: string, creds: JiraCredentials): Promise<Response> {
  const baseUrl = `https://api.atlassian.com/ex/jira/${creds.cloudId}`;
  return fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${creds.apiToken}`,
      Accept: "application/json",
    },
  });
}


export async function validateJiraProject(
  projectKey: string,
  modelFieldId: string | null,
  columnMappings?: Partial<JiraColumnMappings>,
  credentials?: JiraCredentials
): Promise<ValidationResult> {
  const creds: JiraCredentials = credentials ?? {
    cloudId: env.JIRA_CLOUD_ID,
    apiToken: env.JIRA_API_TOKEN,
  };
  const checks: ValidationCheck[] = [];
  const resolvedMappings = resolveJiraColumnMappings(columnMappings);
  const requiredStatuses = [
    resolvedMappings.backlog,
    resolvedMappings.toDo,
    resolvedMappings.inProgress,
    resolvedMappings.inReview,
    resolvedMappings.done,
  ];

  // Check 1: Workflow statuses (project-specific via Platform API)
  try {
    const res = await jiraFetch(
      `/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`,
      creds
    );
    if (!res.ok) {
      checks.push({
        name: "Workflow statuses",
        passed: false,
        message: `Failed to fetch project statuses: ${res.status} ${res.statusText}`,
      });
    } else {
      const issueTypes = (await res.json()) as Array<{
        statuses: Array<{ name: string }>;
      }>;
      const statusNames = [
        ...new Set(
          issueTypes.flatMap((it) => it.statuses.map((s) => s.name))
        ),
      ];
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
          message: `Missing statuses: ${missing.join(", ")}. Found: ${statusNames.length > 0 ? statusNames.join(", ") : "(none)"}`,
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

  const valid = checks.every((c) => c.passed);
  return { valid, checks };
}
