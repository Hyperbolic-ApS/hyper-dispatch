export interface JiraColumnMappings {
  backlog: string;
  toDo: string;
  inProgress: string;
  inReview: string;
  done: string;
}

export const DEFAULT_JIRA_COLUMN_MAPPINGS: JiraColumnMappings = {
  backlog: "Backlog",
  toDo: "To Do",
  inProgress: "In Progress",
  inReview: "In Review",
  done: "Done",
};

export function resolveJiraColumnMappings(
  mappings?: Partial<JiraColumnMappings>
): JiraColumnMappings {
  return {
    backlog: mappings?.backlog?.trim() || DEFAULT_JIRA_COLUMN_MAPPINGS.backlog,
    toDo: mappings?.toDo?.trim() || DEFAULT_JIRA_COLUMN_MAPPINGS.toDo,
    inProgress:
      mappings?.inProgress?.trim() || DEFAULT_JIRA_COLUMN_MAPPINGS.inProgress,
    inReview: mappings?.inReview?.trim() || DEFAULT_JIRA_COLUMN_MAPPINGS.inReview,
    done: mappings?.done?.trim() || DEFAULT_JIRA_COLUMN_MAPPINGS.done,
  };
}

export function jiraNamesEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
