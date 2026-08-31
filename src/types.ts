/**
 * Shared data structures, constants, and types for ZenSpec
 */

export const DocType = {
  Markdown: "markdown",
  Html: "html",
} as const;
export type DocumentType = (typeof DocType)[keyof typeof DocType];

export const AgentPresence = {
  Waiting: "waiting",
  Listening: "listening",
  Working: "working",
} as const;
export type AgentPresenceState = (typeof AgentPresence)[keyof typeof AgentPresence];

export const ActorRole = {
  User: "user",
  Agent: "agent",
} as const;
export type ActorRole = (typeof ActorRole)[keyof typeof ActorRole];

export const ProgressStatus = {
  Running: "running",
  Done: "done",
  Error: "error",
} as const;
export type ProgressStatus = (typeof ProgressStatus)[keyof typeof ProgressStatus];

export const PollStatus = {
  Feedback: "feedback",
  Approved: "approved",
  Ended: "ended",
  Superseded: "superseded",
} as const;
export type PollStatus = (typeof PollStatus)[keyof typeof PollStatus];

export const PromptTag = {
  Annotation: "annotation",
  Suggestion: "suggestion",
  Question: "question",
  Chat: "chat",
  Diagram: "diagram",
} as const;
export type PromptTag = (typeof PromptTag)[keyof typeof PromptTag];

export const DiffType = {
  Added: "added",
  Modified: "modified",
  Deleted: "deleted",
} as const;
export type DiffType = (typeof DiffType)[keyof typeof DiffType];

export const TargetType = {
  MarkdownRange: "markdown-range",
  DomElement: "dom-element",
} as const;
export type TargetType = (typeof TargetType)[keyof typeof TargetType];

export const ServerEvent = {
  Presence: "presence",
  Progress: "progress",
  Diff: "diff",
  Chat: "chat",
  Approved: "approved",
  Ended: "ended",
  Reload: "reload",
} as const;
export type ServerEvent = (typeof ServerEvent)[keyof typeof ServerEvent];

export const McpToolName = {
  OpenReview: "zen_open_review",
  PollFeedback: "zen_poll_feedback",
  ApprovePlan: "zen_approve_plan",
  Reply: "zen_reply",
  Progress: "zen_progress",
  EndSession: "zen_end_session",
  GetStatus: "zen_get_status",
  ExportAdr: "zen_export_adr",
} as const;
export type McpToolName = (typeof McpToolName)[keyof typeof McpToolName];

export const SERVER_DEFAULTS = {
  PORT: 4388,
  HOST: "127.0.0.1",
} as const;

export interface MarkdownTarget {
  type: typeof TargetType.MarkdownRange;
  startLine: number;
  endLine: number;
  selectedText?: string;
  replacementText?: string;
  headingContext?: string;
}

export interface HtmlTarget {
  type: typeof TargetType.DomElement;
  selector: string;
  tagName: string;
  textPreview?: string;
  tableInfo?: {
    rowName?: string;
    columnName?: string;
  };
}

export interface PromptItem {
  id: string;
  queueKey?: string;
  tag: PromptTag;
  text: string;
  target?: MarkdownTarget | HtmlTarget;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  sender: ActorRole;
  text: string;
  createdAt: string;
}

export interface AgentProgressUpdate {
  id: string;
  timestamp: string;
  step: string;
  status: ProgressStatus;
  details?: string;
}

export interface WorkspaceDocumentInfo {
  relPath: string;
  absPath: string;
  docType: DocumentType;
  sizeBytes: number;
  lastModified: number;
}

export interface DiffRange {
  startLine: number;
  endLine: number;
  type: DiffType;
  oldText?: string;
  newText?: string;
}

export interface SessionState {
  key: string;
  filePath: string;
  canonicalPath: string;
  docType: DocumentType;
  token?: string;
  workspaceRoot?: string;
  workspaceFiles?: string[];
  ended: boolean;
  endedBy?: ActorRole;
  approved: boolean;
  approvedAt?: string;
  presence: AgentPresenceState;
  activeProgress?: AgentProgressUpdate;
  queuedPrompts: PromptItem[];
  chatHistory: ChatMessage[];
  lastModified: number;
  previousContent?: string;
  currentContent?: string;
  diffs?: DiffRange[];
}

export interface PollFeedbackResponse {
  status: typeof PollStatus.Feedback;
  file: string;
  prompts: PromptItem[];
  approved?: boolean;
  sessionEnded?: boolean;
  endedBy?: ActorRole;
}

export interface PollApprovedResponse {
  status: typeof PollStatus.Approved;
  file: string;
  approved: true;
  approvedAt?: string;
  prompts?: PromptItem[];
  message: string;
  sessionEnded?: boolean;
  endedBy?: ActorRole;
}

export interface PollEndedResponse {
  status: typeof PollStatus.Ended;
  file: string;
  approved?: boolean;
  endedBy?: ActorRole;
  message: string;
}

export interface PollSupersededResponse {
  status: typeof PollStatus.Superseded;
  file: string;
  message: string;
}

export type PollResponse =
  PollFeedbackResponse | PollApprovedResponse | PollEndedResponse | PollSupersededResponse;
