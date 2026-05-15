export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  avatarUrls?: Record<string, string>;
}

export interface JiraStatusCategory {
  id: number;
  key: string;
  colorName: string;
  name: string;
}

export interface JiraStatus {
  id: string;
  name: string;
  description?: string;
  statusCategory: JiraStatusCategory;
}

export interface JiraPriority {
  id: string;
  name: string;
  iconUrl?: string;
}

export interface JiraIssueLinkType {
  id: string;
  name: string;
  inward: string;
  outward: string;
}

export interface JiraIssueRef {
  id: string;
  key: string;
  fields?: {
    summary?: string;
    status?: JiraStatus;
    priority?: JiraPriority;
  };
}

export interface JiraIssueLink {
  id: string;
  type: JiraIssueLinkType;
  inwardIssue?: JiraIssueRef;
  outwardIssue?: JiraIssueRef;
}

export interface JiraIssueFields {
  summary: string;
  description?: unknown; // Jira Document Format (ADF)
  status: JiraStatus;
  priority?: JiraPriority;
  assignee?: JiraUser;
  reporter?: JiraUser;
  issuelinks?: JiraIssueLink[];
  project?: {
    id: string;
    key: string;
    name: string;
  };
  issuetype?: {
    id: string;
    name: string;
    subtask: boolean;
  };
  [key: string]: unknown;
}

export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: JiraIssueFields;
}

export interface JiraSearchResponse {
  issues: JiraIssue[];
  nextPageToken?: string;
}

export interface JiraTransition {
  id: string;
  name: string;
  to: JiraStatus;
  isInitial?: boolean;
  isGlobal?: boolean;
  isConditional?: boolean;
}

export interface JiraTransitionsResponse {
  transitions: JiraTransition[];
}

export interface JiraBoardColumnConfig {
  columns: Array<{
    name: string;
    statuses: Array<{ id: string }>;
  }>;
}

export interface JiraBoardConfig {
  id: number;
  name: string;
  type: string;
  columnConfig: JiraBoardColumnConfig;
  estimation?: {
    type: string;
    field?: {
      fieldId: string;
      displayName: string;
    };
  };
}

export interface JiraField {
  id: string;
  name: string;
  custom: boolean;
  orderable: boolean;
  navigable: boolean;
  searchable: boolean;
  clauseNames: string[];
  schema?: {
    type: string;
    system?: string;
    custom?: string;
    customId?: number;
  };
}
