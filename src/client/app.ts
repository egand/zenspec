/**
 * Zen AXI Browser Client Logic
 */

interface PromptItem {
  id: string;
  tag: "annotation" | "question" | "chat" | "diagram";
  text: string;
  target?: {
    type: "markdown-range" | "dom-element";
    startLine?: number;
    endLine?: number;
    selectedText?: string;
    headingContext?: string;
    selector?: string;
  };
  createdAt: string;
}

let sessionKey = "";
let queuedPrompts: PromptItem[] = [];
let activeHighlight: {
  text: string;
  startLine: number;
  endLine: number;
  headingContext?: string;
} | null = null;

// Determine session key from URL: /session/:key or ?key=...
function extractSessionKey(): string {
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  if (pathParts[0] === "session" && pathParts[1]) {
    return pathParts[1];
  }
  const params = new URLSearchParams(window.location.search);
  return params.get("key") || "";
}

function showToast(message: string) {
  const toast = document.getElementById("zen-toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3000);
}

// -----------------------------------------------------------------------------
// Document Loading and Rendering
// -----------------------------------------------------------------------------
async function loadDocument() {
  if (!sessionKey) return;
  try {
    const res = await fetch(`/api/${sessionKey}/document`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Update Header
    const fileNameEl = document.getElementById("zen-file-name");
    const docTypeEl = document.getElementById("zen-doc-type");
    if (fileNameEl) fileNameEl.textContent = data.file;
    if (docTypeEl) docTypeEl.textContent = data.docType.toUpperCase();

    // Render Canvas
    const container = document.getElementById("zen-document-view");
    if (!container) return;

    if (data.docType === "markdown") {
      container.innerHTML = data.renderedHtml;

      // Initialize Mermaid diagrams
      if ((window as any).mermaid) {
        try {
          (window as any).mermaid.initialize({ startOnLoad: false, theme: "dark" });
          (window as any).mermaid.run({
            nodes: container.querySelectorAll(".mermaid"),
          });
        } catch (e) {
          console.warn("Mermaid render error:", e);
        }
      }

      // Initialize Markmaps
      if ((window as any).markmap) {
        // markmap auto-renders markmap-svg elements
      }

      // Attach task list click handlers
      container.querySelectorAll(".zen-task-checkbox").forEach((cb) => {
        cb.addEventListener("change", (e: any) => {
          const li = e.target.closest("li");
          const label = li?.textContent?.trim() || "Choice";
          const node = e.target.closest("[data-line-start]");
          const line = node ? parseInt(node.getAttribute("data-line-start"), 10) : 1;

          queuePrompt({
            id: `task-${Date.now()}`,
            tag: "question",
            text: `Selected choice: "${label}"`,
            target: {
              type: "markdown-range",
              startLine: line,
              endLine: line,
              selectedText: label,
            },
            createdAt: new Date().toISOString(),
          });
          showToast(`✓ Choice queued: ${label}`);
        });
      });

      // Attach diagram comment buttons
      container.querySelectorAll(".zen-diagram-comment-btn").forEach((btn: any) => {
        btn.addEventListener("click", (e: any) => {
          e.stopPropagation();
          const node = btn.closest("[data-line-start]");
          const startLine = node ? parseInt(node.getAttribute("data-line-start"), 10) : 1;
          const endLine = node ? parseInt(node.getAttribute("data-line-end"), 10) : startLine;

          openAnnotationModal({
            text: "Mermaid Architecture Diagram",
            startLine,
            endLine,
            headingContext: "Diagram",
          });
        });
      });
    } else {
      // HTML Document inside sandboxed iframe
      container.innerHTML = `<iframe id="zen-iframe" srcdoc="${escapeHtml(data.raw)}" style="width:100%;height:80vh;border:none;"></iframe>`;
    }

    // Render Chat History
    renderChat(data.chatHistory || []);
  } catch (err: any) {
    console.error("Load document error:", err);
    showToast(`Error loading document: ${err.message}`);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// -----------------------------------------------------------------------------
// SSE Stream Setup
// -----------------------------------------------------------------------------
function setupSSE() {
  if (!sessionKey) return;
  const es = new EventSource(`/events/${sessionKey}`);

  es.addEventListener("reload", () => {
    showToast("⟳ File updated on disk. Re-rendering...");
    loadDocument();
  });

  es.addEventListener("presence", (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      updatePresence(data.presence);
    } catch (err) {
      console.debug("SSE presence parse error", err);
    }
  });

  es.addEventListener("chat", (e: MessageEvent) => {
    try {
      const msg = JSON.parse(e.data);
      appendChatMessage(msg);
      showToast(`💬 Agent reply: ${msg.text.slice(0, 40)}...`);
    } catch (err) {
      console.debug("SSE chat parse error", err);
    }
  });

  es.addEventListener("ended", () => {
    showToast("🛑 Session ended.");
    const endBtn = document.getElementById("zen-end-btn");
    if (endBtn) {
      endBtn.textContent = "Session Ended (Read Only)";
      (endBtn as HTMLButtonElement).disabled = true;
    }
  });

  es.onerror = () => {
    // Reconnection is automatic in EventSource
  };
}

function updatePresence(presence: string) {
  const chip = document.getElementById("zen-presence");
  const textEl = chip?.querySelector(".zen-presence-text");
  if (!chip || !textEl) return;

  chip.className = `zen-presence-chip zen-presence-${presence}`;
  if (presence === "listening") {
    textEl.textContent = "Agent listening";
  } else if (presence === "working") {
    textEl.textContent = "Agent working...";
  } else {
    textEl.textContent = "Waiting for agent";
  }
}

// -----------------------------------------------------------------------------
// Selection & Annotation Handling
// -----------------------------------------------------------------------------
function setupSelectionListeners() {
  const pill = document.getElementById("zen-floating-pill");
  if (!pill) return;

  document.addEventListener("mouseup", (_e: MouseEvent) => {
    const modal = document.getElementById("zen-modal");
    if (modal && modal.style.display === "flex") return;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      pill.style.display = "none";
      return;
    }

    const text = sel.toString().trim();
    if (text.length < 2) {
      pill.style.display = "none";
      return;
    }

    const range = sel.getRangeAt(0);
    const containerNode = range.startContainer.parentElement?.closest("[data-line-start]");
    const startLine = containerNode
      ? parseInt(containerNode.getAttribute("data-line-start") || "1", 10)
      : 1;
    const endLine = containerNode
      ? parseInt(containerNode.getAttribute("data-line-end") || String(startLine), 10)
      : startLine;

    activeHighlight = {
      text,
      startLine,
      endLine,
    };

    const rect = range.getBoundingClientRect();
    pill.style.display = "block";
    pill.style.top = `${rect.top + window.scrollY - 38}px`;
    pill.style.left = `${rect.left + window.scrollX + rect.width / 2 - 50}px`;
  });

  pill.addEventListener("mousedown", (e) => {
    e.preventDefault();
    pill.style.display = "none";
    if (activeHighlight) {
      openAnnotationModal(activeHighlight);
    }
  });
}

function openAnnotationModal(data: {
  text: string;
  startLine: number;
  endLine: number;
  headingContext?: string;
}) {
  const modal = document.getElementById("zen-modal");
  const quoteEl = document.getElementById("zen-modal-quote");
  const badgeEl = document.getElementById("zen-modal-line-badge");
  const inputEl = document.getElementById("zen-modal-input") as HTMLTextAreaElement;

  if (!modal || !quoteEl || !badgeEl || !inputEl) return;

  activeHighlight = data;
  quoteEl.textContent = `"${data.text}"`;
  badgeEl.textContent = `Lines ${data.startLine}-${data.endLine}`;
  inputEl.value = "";

  modal.style.display = "flex";
  setTimeout(() => inputEl.focus(), 50);
}

function closeAnnotationModal() {
  const modal = document.getElementById("zen-modal");
  if (modal) modal.style.display = "none";
}

// -----------------------------------------------------------------------------
// Queue Management & Prompt Submission
// -----------------------------------------------------------------------------
function queuePrompt(item: PromptItem) {
  queuedPrompts.push(item);
  renderQueue();
}

function renderQueue() {
  const listEl = document.getElementById("zen-queue-list");
  const countEl = document.getElementById("zen-queue-count");
  if (!listEl || !countEl) return;

  countEl.textContent = String(queuedPrompts.length);

  if (queuedPrompts.length === 0) {
    listEl.innerHTML =
      '<div class="zen-empty-queue">Highlight text or click an element to queue feedback for the agent.</div>';
    return;
  }

  listEl.innerHTML = queuedPrompts
    .map((p, idx) => {
      const lineInfo = p.target?.startLine
        ? `Lines ${p.target.startLine}-${p.target.endLine || p.target.startLine}`
        : "General";
      return `
      <div class="zen-queue-card">
        <div class="zen-queue-card-meta">
          <span>[${p.tag.toUpperCase()}] ${lineInfo}</span>
          <button type="button" class="zen-queue-remove-btn" data-idx="${idx}" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;">✕</button>
        </div>
        <div class="zen-queue-card-text">${escapeHtml(p.text)}</div>
      </div>
    `;
    })
    .join("");

  listEl.querySelectorAll(".zen-queue-remove-btn").forEach((btn: any) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx, 10);
      queuedPrompts.splice(idx, 1);
      renderQueue();
    });
  });
}

async function sendQueuedPrompts(endSession = false) {
  const composerInput = document.getElementById("zen-composer-input") as HTMLTextAreaElement;
  const extraText = composerInput?.value.trim();

  if (extraText) {
    queuedPrompts.push({
      id: `note-${Date.now()}`,
      tag: "chat",
      text: extraText,
      createdAt: new Date().toISOString(),
    });
    if (composerInput) composerInput.value = "";
  }

  if (queuedPrompts.length === 0 && !endSession) {
    showToast("⚠️ No prompts in queue to send.");
    return;
  }

  try {
    const res = await fetch(`/api/${sessionKey}/prompts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompts: queuedPrompts,
        endSession,
      }),
    });

    if (res.ok) {
      showToast(`✓ ${queuedPrompts.length} prompt(s) delivered to agent!`);
      queuedPrompts = [];
      renderQueue();
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err: any) {
    showToast(`Failed to send: ${err.message}`);
  }
}

// -----------------------------------------------------------------------------
// Chat History Rendering
// -----------------------------------------------------------------------------
function renderChat(messages: any[]) {
  const stream = document.getElementById("zen-chat-stream");
  if (!stream) return;
  stream.innerHTML = messages
    .map(
      (m) => `
    <div class="zen-chat-msg zen-chat-${m.sender}">
      <strong>${m.sender === "agent" ? "🤖 Agent" : "👤 You"}:</strong> ${escapeHtml(m.text)}
    </div>
  `,
    )
    .join("");
  stream.scrollTop = stream.scrollHeight;
}

function appendChatMessage(msg: any) {
  const stream = document.getElementById("zen-chat-stream");
  if (!stream) return;
  const el = document.createElement("div");
  el.className = `zen-chat-msg zen-chat-${msg.sender}`;
  el.innerHTML = `<strong>${msg.sender === "agent" ? "🤖 Agent" : "👤 You"}:</strong> ${escapeHtml(msg.text)}`;
  stream.appendChild(el);
  stream.scrollTop = stream.scrollHeight;
}

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------
function init() {
  sessionKey = extractSessionKey();
  if (!sessionKey) {
    const container = document.getElementById("zen-document-view");
    if (container)
      container.innerHTML = '<div class="zen-loading">No active session specified.</div>';
    return;
  }

  loadDocument();
  setupSSE();
  setupSelectionListeners();

  // Modal event listeners
  document.getElementById("zen-modal-cancel")?.addEventListener("click", closeAnnotationModal);
  document.getElementById("zen-modal-submit")?.addEventListener("click", () => {
    const input = document.getElementById("zen-modal-input") as HTMLTextAreaElement;
    const text = input?.value.trim();
    if (!text) {
      alert("Please enter a comment for the agent.");
      return;
    }

    if (activeHighlight) {
      queuePrompt({
        id: `ann-${Date.now()}`,
        tag: "annotation",
        text,
        target: {
          type: "markdown-range",
          startLine: activeHighlight.startLine,
          endLine: activeHighlight.endLine,
          selectedText: activeHighlight.text,
          headingContext: activeHighlight.headingContext,
        },
        createdAt: new Date().toISOString(),
      });
      showToast(
        `✓ Comment queued for lines ${activeHighlight.startLine}-${activeHighlight.endLine}`,
      );
    }
    closeAnnotationModal();
  });

  // Modal chip autofills
  document.querySelectorAll(".zen-chip-sm").forEach((chip: any) => {
    chip.addEventListener("click", () => {
      const input = document.getElementById("zen-modal-input") as HTMLTextAreaElement;
      if (input && chip.dataset.fill) {
        input.value = chip.dataset.fill;
        input.focus();
      }
    });
  });

  // Action chips in sidebar
  document.querySelectorAll(".zen-chip").forEach((chip: any) => {
    chip.addEventListener("click", () => {
      const action = chip.dataset.action;
      const promptsMap: Record<string, string> = {
        diagram: "Please add a Mermaid sequence or flowchart diagram to visualize this.",
        concise: "Please make this section more concise and focused.",
        testcases: "Please specify concrete test cases, edge cases, and failure modes.",
        table: "Please convert this data/comparison into a clear Markdown table.",
      };

      const sel = window.getSelection();
      const selectedText = sel?.toString().trim() || activeHighlight?.text || "Selected section";

      queuePrompt({
        id: `action-${Date.now()}`,
        tag: "annotation",
        text: promptsMap[action] || "Action requested",
        target: activeHighlight
          ? {
              type: "markdown-range",
              startLine: activeHighlight.startLine,
              endLine: activeHighlight.endLine,
              selectedText,
            }
          : undefined,
        createdAt: new Date().toISOString(),
      });
      showToast(`✓ Queued action: ${chip.textContent}`);
    });
  });

  // Send buttons
  document
    .getElementById("zen-send-btn")
    ?.addEventListener("click", () => sendQueuedPrompts(false));
  document
    .getElementById("zen-send-end-btn")
    ?.addEventListener("click", () => sendQueuedPrompts(true));

  // End button
  document.getElementById("zen-end-btn")?.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to end this review session?")) return;
    await fetch(`/api/${sessionKey}/end`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endedBy: "user" }),
    });
    showToast("Session concluded.");
  });

  // Theme toggle
  const themeToggle = document.getElementById("zen-theme-toggle");
  themeToggle?.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("zen-theme", next);
  });

  const savedTheme = localStorage.getItem("zen-theme");
  if (savedTheme) {
    document.documentElement.setAttribute("data-theme", savedTheme);
  }
}

document.addEventListener("DOMContentLoaded", init);
