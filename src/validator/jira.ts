import { env } from "../config/env.js";

export interface ValidationCheck {
  name: string;
  passed: boolean;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  checks: ValidationCheck[];
}

function jiraAuthHeader(): string {
  const credentials = `${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`;
  return "Basic " + Buffer.from(credentials).toString("base64");
}

async function jiraFetch(path: string): Promise<Response> {
  return fetch(`${env.JIRA_BASE_URL}${path}`, {
    headers: {
      Authorization: jiraAuthHeader(),
      Accept: "application/json",
    },
  });
}

const REQUIRED_COLUMNS = ["Backlog", "To Do", "In Progress", "In Review", "Done"];
const REQUIRED_STATUSES = ["Backlog", "To Do", "In Progress", "In Review", "Done"];

export async function validateJiraProject(
  boardId: number,
  modelFieldId: string | null
): Promise<ValidationResult> {
  const checks: ValidationCheck[] = [];

  // Check 1: Board columns
  try {
    const res = await jiraFetch(`/rest/agile/1.0/board/${boardId}/configuration`);
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
      const missing = REQUIRED_COLUMNS.filter(
        (req) => !columns.some((col) => col.toLowerCase() === req.toLowerCase())
      );
      if (missing.length === 0) {
        checks.push({
          name: "Board columns",
          passed: true,
          message: `All required columns present: ${REQUIRED_COLUMNS.join(", ")}`,
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
      const res = await jiraFetch("/rest/api/3/field");
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
    const res = await jiraFetch("/rest/api/3/status");
    if (!res.ok) {
      checks.push({
        name: "Workflow statuses",
        passed: false,
        message: `Failed to fetch statuses: ${res.status} ${res.statusText}`,
      });
    } else {
      const statuses = (await res.json()) as Array<{ name: string }>;
      const statusNames = statuses.map((s) => s.name);
      const missing = REQUIRED_STATUSES.filter(
        (req) =>
          !statusNames.some((s) => s.toLowerCase() === req.toLowerCase())
      );
      if (missing.length === 0) {
        checks.push({
          name: "Workflow statuses",
          passed: true,
          message: `All required statuses present: ${REQUIRED_STATUSES.join(", ")}`,
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
