/**
 * Zen AXI Browser Client Logic
 */

interface PromptItem {
  id: string;
  queueKey?: string;
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
          (window as any).mermaid.initialize({
            startOnLoad: false,
            theme: "dark",
            themeVariables: {
              background: "#161b22",
              primaryColor: "#21262d",
              primaryBorderColor: "#30363d",
              primaryTextColor: "#f0f6fc",
              lineColor: "#3b82f6",
              textColor: "#f0f6fc",
            },
          });
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

      // Render KaTeX Math Formulas if any unrendered math remains
      if ((window as any).renderMathInElement) {
        try {
          (window as any).renderMathInElement(container, {
            delimiters: [
              { left: "$$", right: "$$", display: true },
              { left: "$", right: "$", display: false },
            ],
            throwOnError: false,
          });
        } catch (e) {
          console.warn("KaTeX render error:", e);
        }
      }

      // Attach Interactive Question Option Card Listeners
      container.querySelectorAll(".zen-option-card").forEach((card: any) => {
        card.addEventListener("click", () => {
          const qContainer = card.closest(".zen-callout-question");
          const radio = card.querySelector('input[type="radio"]') as HTMLInputElement;
          const questionId = qContainer?.dataset.questionId || "q";
          const title =
            qContainer?.querySelector(".zen-callout-title")?.textContent?.replace(/^❓\s*/, "") ||
            "Question";
          const optionValue =
            card.dataset.value || card.querySelector(".zen-option-text")?.textContent?.trim() || "";

          // Check this radio
          if (radio) radio.checked = true;

          // Update UI selection state on sibling cards
          if (qContainer) {
            qContainer.querySelectorAll(".zen-option-card").forEach((c: any) => {
              c.classList.remove("selected");
            });
            card.classList.add("selected");

            const statusEl = qContainer.querySelector(`#status-${questionId}`);
            if (statusEl) {
              statusEl.textContent = `✓ Selected: ${optionValue}`;
            }
          }

          // Read line number
          const node = qContainer?.closest("[data-line-start]") || qContainer;
          const line = node ? parseInt(node.getAttribute("data-line-start") || "1", 10) : 1;

          // Queue / Replace this question's answer in-place
          queueOrReplacePrompt({
            id: `q-${questionId}`,
            queueKey: `question-${questionId}`,
            tag: "question",
            text: `Answer to "${title}": ${optionValue}`,
            target: {
              type: "markdown-range",
              startLine: line,
              endLine: line,
              selectedText: optionValue,
            },
            createdAt: new Date().toISOString(),
          });

          showToast(`✓ Selected: "${optionValue}"`);
        });
      });

      // Attach Question Confirm Buttons
      container.querySelectorAll(".zen-question-confirm-btn").forEach((btn: any) => {
        btn.addEventListener("click", (e: any) => {
          e.stopPropagation();
          const qContainer = btn.closest(".zen-callout-question");
          const selectedCard = qContainer?.querySelector(
            ".zen-option-card.selected",
          ) as HTMLElement;

          if (!selectedCard) {
            // Auto-select first option if none is selected
            const firstCard = qContainer?.querySelector(".zen-option-card") as HTMLElement;
            if (firstCard) {
              firstCard.click();
              return;
            }
            showToast("Please select an option first.");
            return;
          }

          const optionValue =
            selectedCard.dataset.value ||
            selectedCard.querySelector(".zen-option-text")?.textContent?.trim() ||
            "";
          showToast(`✓ Confirmed answer: "${optionValue}"`);
        });
      });

      // Attach Diagram Comment Buttons
      container.querySelectorAll(".zen-diagram-comment-btn").forEach((btn: any) => {
        btn.addEventListener("click", (e: any) => {
          e.stopPropagation();
          const node = btn.closest("[data-line-start]");
          const startLine = node ? parseInt(node.getAttribute("data-line-start"), 10) : 1;
          const endLine = node ? parseInt(node.getAttribute("data-line-end"), 10) : startLine;

          openAnnotationModal({
            text: "Architecture Diagram",
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

// -----------------------------------------------------------------------------
// Live Reload & Presence via Server-Sent Events (SSE)
// -----------------------------------------------------------------------------
function setupEventStream() {
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
    const rect = range.getBoundingClientRect();

    // Find nearest ancestor block with line numbers
    let startLine = 1;
    let endLine = 1;
    let headingContext = "";

    let node: Node | null = range.startContainer;
    while (node && node !== document.body) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        if (el.hasAttribute("data-line-start")) {
          startLine = parseInt(el.getAttribute("data-line-start") || "1", 10);
          endLine = parseInt(el.getAttribute("data-line-end") || String(startLine), 10);
          break;
        }
      }
      node = node.parentNode;
    }

    // Find preceding heading context
    let prev: Element | null = node as Element | null;
    while (prev) {
      if (/^H[1-6]$/i.test(prev.tagName)) {
        headingContext = prev.textContent || "";
        break;
      }
      prev = prev.previousElementSibling;
    }

    activeHighlight = {
      text,
      startLine,
      endLine,
      headingContext,
    };

    // Position floating pill above selection
    pill.style.top = `${window.scrollY + rect.top - 42}px`;
    pill.style.left = `${window.scrollX + rect.left + rect.width / 2 - 60}px`;
    pill.style.display = "flex";
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

function queueOrReplacePrompt(item: PromptItem) {
  if (item.queueKey) {
    const idx = queuedPrompts.findIndex((p) => p.queueKey === item.queueKey);
    if (idx !== -1) {
      queuedPrompts[idx] = item;
      renderQueue();
      return;
    }
  }
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
          <button type="button" class="zen-queue-remove-btn" data-idx="${idx}" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:0.9rem;">✕</button>
        </div>
        <div class="zen-queue-card-text">${escapeHtml(p.text)}</div>
      </div>`;
    })
    .join("");

  listEl.querySelectorAll(".zen-queue-remove-btn").forEach((btn: any) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx, 10);
      queuedPrompts.splice(idx, 1);
      renderQueue();
      showToast("Feedback item removed.");
    });
  });
}

async function sendPrompts(shouldEndSession = false) {
  if (queuedPrompts.length === 0 && !shouldEndSession) {
    showToast("No feedback items queued.");
    return;
  }

  try {
    const res = await fetch(`/api/${sessionKey}/prompts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompts: queuedPrompts,
        endSession: shouldEndSession,
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    showToast(
      shouldEndSession
        ? "✓ Feedback sent and session concluded."
        : "🚀 Feedback sent to agent. Agent is working...",
    );

    queuedPrompts = [];
    renderQueue();
  } catch (err: any) {
    console.error("Send prompts error:", err);
    showToast(`Failed to send prompts: ${err.message}`);
  }
}

// -----------------------------------------------------------------------------
// Chat Conversation Stream
// -----------------------------------------------------------------------------
function renderChat(history: any[]) {
  const stream = document.getElementById("zen-chat-stream");
  if (!stream) return;

  if (history.length === 0) {
    stream.style.display = "none";
    return;
  }

  stream.style.display = "flex";
  stream.innerHTML = history
    .map(
      (msg) => `
    <div class="zen-chat-bubble zen-chat-${msg.sender}">
      <div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:2px;">${msg.sender.toUpperCase()}</div>
      <div>${escapeHtml(msg.text)}</div>
    </div>`,
    )
    .join("");

  stream.scrollTop = stream.scrollHeight;
}

function appendChatMessage(msg: any) {
  const stream = document.getElementById("zen-chat-stream");
  if (!stream) return;

  stream.style.display = "flex";
  const bubble = document.createElement("div");
  bubble.className = `zen-chat-bubble zen-chat-${msg.sender}`;
  bubble.innerHTML = `
    <div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:2px;">${msg.sender.toUpperCase()}</div>
    <div>${escapeHtml(msg.text)}</div>`;
  stream.appendChild(bubble);
  stream.scrollTop = stream.scrollHeight;
}

// -----------------------------------------------------------------------------
// UI Utilities & Setup
// -----------------------------------------------------------------------------
function showToast(message: string) {
  const toast = document.getElementById("zen-toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("zen-toast-visible");
  setTimeout(() => {
    toast.classList.remove("zen-toast-visible");
  }, 3000);
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function setupUiListeners() {
  // Theme Toggle
  document.getElementById("zen-theme-toggle")?.addEventListener("click", () => {
    const html = document.documentElement;
    const current = html.getAttribute("data-theme") || "dark";
    const next = current === "dark" ? "light" : "dark";
    html.setAttribute("data-theme", next);
    localStorage.setItem("zen-theme", next);
  });

  // End Session Button
  document.getElementById("zen-end-btn")?.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to end this review session?")) return;
    try {
      await fetch(`/api/${sessionKey}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endedBy: "user" }),
      });
      showToast("🛑 Review session ended.");
    } catch (e: any) {
      showToast(`Error ending session: ${e.message}`);
    }
  });

  // Toggle Sidebar
  document.getElementById("zen-toggle-sidebar")?.addEventListener("click", () => {
    const sidebar = document.getElementById("zen-sidebar");
    if (sidebar) {
      sidebar.style.display = sidebar.style.display === "none" ? "flex" : "none";
    }
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

  // Modal Cancel & Submit
  document.getElementById("zen-modal-cancel")?.addEventListener("click", closeAnnotationModal);
  document.getElementById("zen-modal-submit")?.addEventListener("click", () => {
    const input = document.getElementById("zen-modal-input") as HTMLTextAreaElement;
    const text = input?.value.trim();
    if (!text) {
      showToast("Please enter feedback before queueing.");
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
        `✓ Feedback queued for lines ${activeHighlight.startLine}-${activeHighlight.endLine}`,
      );
    }

    closeAnnotationModal();
  });

  // Modal quick fill chips
  document.querySelectorAll(".zen-chip-sm").forEach((chip: any) => {
    chip.addEventListener("click", () => {
      const input = document.getElementById("zen-modal-input") as HTMLTextAreaElement;
      if (input) {
        input.value = chip.dataset.fill || "";
        input.focus();
      }
    });
  });

  // Composer Input
  const composerInput = document.getElementById("zen-composer-input") as HTMLTextAreaElement;
  composerInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const val = composerInput.value.trim();
      if (!val) return;

      queuePrompt({
        id: `note-${Date.now()}`,
        tag: "chat",
        text: val,
        createdAt: new Date().toISOString(),
      });

      composerInput.value = "";
      showToast("✓ Note added to queue.");
    }
  });

  // Send Prompts Button
  document.getElementById("zen-send-btn")?.addEventListener("click", () => sendPrompts(false));
  document.getElementById("zen-send-end-btn")?.addEventListener("click", () => sendPrompts(true));

  // Keyboard Shortcuts (Esc to close modal)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeAnnotationModal();
    }
  });
}

// -----------------------------------------------------------------------------
// App Initialization
// -----------------------------------------------------------------------------
function init() {
  sessionKey = extractSessionKey();
  if (!sessionKey) {
    console.error("No session key found in URL.");
    return;
  }

  // Restore saved theme
  const savedTheme = localStorage.getItem("zen-theme") || "dark";
  document.documentElement.setAttribute("data-theme", savedTheme);

  setupUiListeners();
  setupSelectionListeners();
  setupEventStream();
  loadDocument();
}

window.addEventListener("DOMContentLoaded", init);
