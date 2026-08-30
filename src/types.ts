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
  headingContext?: string;
}

export interface HtmlTarget {
  type: "dom-element";
  selector: string;
  tagName: string;
  tableInfo?: {
    rowName?: string;
    columnName?: string;
  };
}

export interface PromptItem {
  id: string;
  tag: "annotation" | "question" | "chat" | "diagram";
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

export interface SessionState {
  key: string;
  filePath: string;
  canonicalPath: string;
  docType: DocumentType;
  ended: boolean;
  endedBy?: "user" | "agent";
  presence: AgentPresenceState;
  queuedPrompts: PromptItem[];
  chatHistory: ChatMessage[];
  lastModified: number;
}

export interface PollFeedbackResponse {
  status: "feedback";
  file: string;
  prompts: PromptItem[];
  sessionEnded?: boolean;
  endedBy?: "user" | "agent";
}

export interface PollEndedResponse {
  status: "ended";
  file: string;
  endedBy?: "user" | "agent";
  message: string;
}

export interface PollSupersededResponse {
  status: "superseded";
  file: string;
  message: string;
}

export type PollResponse = PollFeedbackResponse | PollEndedResponse | PollSupersededResponse;
