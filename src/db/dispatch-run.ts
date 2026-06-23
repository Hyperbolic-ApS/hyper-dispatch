export interface DispatchRun {
  id: string | null;
  ticket_key: string;
  project_key: string;
  run_type: string | null;
  run_id: string | null;
  status:
    | "blocked"
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "stale"
    | "blocked_cycle";
  model: string | null;
  spawned_at: Date | null;
  completed_at: Date | null;
  pr_url: string | null;
  pr_has_conflicts: boolean | null;
  pr_display_state: "open" | "draft" | "merged" | "closed" | null;
  pr_review_running: boolean | null;
  pr_revision_running: boolean | null;
  session_link: string | null;
  error: string | null;
  summary: string | null;
  blocked_by: string[] | null;
  priority: number;
  ticket_status_name: string | null;
  ticket_status_category: string | null;
  created_at: Date;
  updated_at: Date;
}
