/**
 * Shared data structures and types for zen-axi
 */

export type DocumentType = "markdown" | "html";

export type AgentPresenceState = "waiting" | "listening" | "working";

export interface MarkdownTarget {
  type: "markdown-range";
  startLine: number;
  endLine: number;
  selectedText?: string;
  replacementText?: string;
  headingContext?: string;
}

export interface HtmlTarget {
  type: "dom-element";
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
  tag: "annotation" | "suggestion" | "question" | "chat" | "diagram";
  text: string;
  target?: MarkdownTarget | HtmlTarget;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  sender: "user" | "agent";
  text: string;
  createdAt: string;
}

export interface AgentProgressUpdate {
  id: string;
  timestamp: string;
  step: string;
  status: "running" | "done" | "error";
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
  type: "added" | "modified" | "deleted";
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
  endedBy?: "user" | "agent";
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
  status: "feedback";
  file: string;
  prompts: PromptItem[];
  approved?: boolean;
  sessionEnded?: boolean;
  endedBy?: "user" | "agent";
}

export interface PollApprovedResponse {
  status: "approved";
  file: string;
  approved: true;
  approvedAt?: string;
  prompts?: PromptItem[];
  message: string;
  sessionEnded?: boolean;
  endedBy?: "user" | "agent";
}

export interface PollEndedResponse {
  status: "ended";
  file: string;
  approved?: boolean;
  endedBy?: "user" | "agent";
  message: string;
}

export interface PollSupersededResponse {
  status: "superseded";
  file: string;
  message: string;
}

export type PollResponse =
  PollFeedbackResponse | PollApprovedResponse | PollEndedResponse | PollSupersededResponse;
