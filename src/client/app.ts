/**
 * Zen AXI Browser Client Logic
 */

interface PromptItem {
  id: string;
  queueKey?: string;
  tag: "annotation" | "suggestion" | "question" | "chat" | "diagram";
  text: string;
  target?: {
    type: "markdown-range" | "dom-element";
    startLine?: number;
    endLine?: number;
    selectedText?: string;
    replacementText?: string;
    headingContext?: string;
    selector?: string;
    tagName?: string;
  };
  createdAt: string;
}

interface DiffRange {
  startLine: number;
  endLine: number;
  type: "added" | "modified" | "deleted";
  oldText?: string;
  newText?: string;
}

let sessionKey = "";
let currentFilePath = "";
let queuedPrompts: PromptItem[] = [];
let activeDiffs: DiffRange[] = [];
let diffsVisible = true;
let modalMode: "comment" | "suggest" = "comment";

let activeHighlight: {
  text: string;
  startLine: number;
  endLine: number;
  headingContext?: string;
} | null = null;

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
async function loadDocument(targetRelFile?: string) {
  if (!sessionKey) return;
  try {
    const url = targetRelFile
      ? `/api/${sessionKey}/document?file=${encodeURIComponent(targetRelFile)}`
      : `/api/${sessionKey}/document`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    currentFilePath = data.file;

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

      // Attach Interactive Question & Rating Listeners
      setupQuestionListeners(container);

      // Attach Code Block Copy Buttons
      setupCodeCopyListeners(container);

      // Attach Diagram Comment Buttons
      setupDiagramListeners(container);

      // Generate Table of Contents (TOC) & Reading Stats
      generateTableOfContents(container);

      // Apply Ghost Diffs if present
      if (data.diffs && data.diffs.length > 0) {
        activeDiffs = data.diffs;
        applyDiffHighlights();
      }
    } else {
      // HTML Document inside sandboxed iframe with element inspector
      container.innerHTML = `<iframe id="zen-iframe" srcdoc="${escapeHtml(
        data.raw,
      )}" style="width:100%;height:80vh;border:none;"></iframe>`;
      setupIframeInspector();
    }

    // Render Margin Comment Pin Indicators
    renderMarginPins();

    // Render Chat History
    renderChat(data.chatHistory || []);
  } catch (err: any) {
    console.error("Load document error:", err);
    showToast(`Error loading document: ${err.message}`);
  }
}

// -----------------------------------------------------------------------------
// Interactive Question & Rating Callouts
// -----------------------------------------------------------------------------
function setupQuestionListeners(container: HTMLElement) {
  container.querySelectorAll(".zen-callout-question").forEach((qContainer: any) => {
    const questionId = qContainer.dataset.questionId || "q";
    const mode = qContainer.dataset.questionMode || "single";
    const title =
      qContainer.querySelector(".zen-callout-title")?.textContent?.replace(/^❓\s*/, "") ||
      "Question";
    const node = qContainer.closest("[data-line-start]") || qContainer;
    const line = node ? parseInt(node.getAttribute("data-line-start") || "1", 10) : 1;

    // Rating (1..5) buttons
    if (mode === "rating" || mode === "scale") {
      qContainer.querySelectorAll(".zen-rating-btn").forEach((btn: any) => {
        btn.addEventListener("click", () => {
          const val = btn.dataset.value;
          qContainer.querySelectorAll(".zen-rating-btn").forEach((b: any) => {
            b.classList.remove("selected");
          });
          btn.classList.add("selected");

          queueOrReplacePrompt({
            id: `q-${questionId}`,
            queueKey: `question-${questionId}`,
            tag: "question",
            text: `Rating for "${title}": ${val}/5 Stars`,
            target: {
              type: "markdown-range",
              startLine: line,
              endLine: line,
              selectedText: `${val}/5`,
            },
            createdAt: new Date().toISOString(),
          });
          showToast(`✓ Rated: ${val}/5 Stars`);
        });
      });
      return;
    }

    // Multi-Select or Single-Select Option Cards
    const isMulti = mode === "multi" || mode === "checkbox";

    const updateMultiSelections = () => {
      const selectedVals: string[] = [];
      qContainer.querySelectorAll(".zen-option-card.selected").forEach((c: any) => {
        const val =
          c.dataset.value ||
          c.querySelector(".zen-option-text")?.textContent?.trim() ||
          c.querySelector(".zen-option-custom-input")?.value?.trim();
        if (val) selectedVals.push(val);
      });

      if (selectedVals.length > 0) {
        queueOrReplacePrompt({
          id: `q-${questionId}`,
          queueKey: `question-${questionId}`,
          tag: "question",
          text: `Answers to "${title}": ${selectedVals.join(", ")}`,
          target: {
            type: "markdown-range",
            startLine: line,
            endLine: line,
            selectedText: selectedVals.join(", "),
          },
          createdAt: new Date().toISOString(),
        });
      }
    };

    qContainer.querySelectorAll(".zen-option-card:not(.zen-option-custom)").forEach((card: any) => {
      card.addEventListener("click", () => {
        const input = card.querySelector(
          'input[type="radio"], input[type="checkbox"]',
        ) as HTMLInputElement;
        const val =
          card.dataset.value || card.querySelector(".zen-option-text")?.textContent?.trim() || "";

        if (isMulti) {
          const isCurrentlySelected = card.classList.contains("selected");
          if (isCurrentlySelected) {
            card.classList.remove("selected");
            if (input) input.checked = false;
          } else {
            card.classList.add("selected");
            if (input) input.checked = true;
          }
          updateMultiSelections();
          showToast(`✓ Updated multi-selection`);
        } else {
          if (input) input.checked = true;
          qContainer.querySelectorAll(".zen-option-card").forEach((c: any) => {
            c.classList.remove("selected");
          });
          card.classList.add("selected");

          queueOrReplacePrompt({
            id: `q-${questionId}`,
            queueKey: `question-${questionId}`,
            tag: "question",
            text: `Answer to "${title}": ${val}`,
            target: {
              type: "markdown-range",
              startLine: line,
              endLine: line,
              selectedText: val,
            },
            createdAt: new Date().toISOString(),
          });
          showToast(`✓ Selected: "${val}"`);
        }
      });
    });

    // Custom write-in option card
    const customCard = qContainer.querySelector(".zen-option-custom") as HTMLElement;
    const customInput = qContainer.querySelector(".zen-option-custom-input") as HTMLInputElement;
    if (customCard && customInput) {
      customCard.addEventListener("click", () => {
        customInput.focus();
        if (!isMulti) {
          qContainer.querySelectorAll(".zen-option-card").forEach((c: any) => {
            c.classList.remove("selected");
          });
          customCard.classList.add("selected");
        }
      });

      customInput.addEventListener("input", () => {
        const val = customInput.value.trim();
        if (!val) return;
        customCard.classList.add("selected");
        if (isMulti) {
          updateMultiSelections();
        } else {
          queueOrReplacePrompt({
            id: `q-${questionId}`,
            queueKey: `question-${questionId}`,
            tag: "question",
            text: `Answer to "${title}": ${val}`,
            target: {
              type: "markdown-range",
              startLine: line,
              endLine: line,
              selectedText: val,
            },
            createdAt: new Date().toISOString(),
          });
        }
      });
    }
  });
}

// -----------------------------------------------------------------------------
// Code Copy Listeners
// -----------------------------------------------------------------------------
function setupCodeCopyListeners(container: HTMLElement) {
  container.querySelectorAll(".zen-code-copy-btn").forEach((btn: any) => {
    btn.addEventListener("click", (e: any) => {
      e.stopPropagation();
      const code =
        btn.dataset.code ||
        btn.closest(".zen-code-block-wrapper")?.querySelector("code")?.textContent ||
        "";
      if (code) {
        navigator.clipboard.writeText(code);
        btn.textContent = "✓ Copied";
        setTimeout(() => {
          btn.textContent = "📋 Copy";
        }, 2000);
        showToast("✓ Code snippet copied to clipboard");
      }
    });
  });
}

// -----------------------------------------------------------------------------
// Diagram Listeners
// -----------------------------------------------------------------------------
function setupDiagramListeners(container: HTMLElement) {
  container.querySelectorAll(".zen-diagram-comment-btn").forEach((btn: any) => {
    btn.addEventListener("click", (e: any) => {
      e.stopPropagation();
      const node = btn.closest("[data-line-start]");
      const startLine = node ? parseInt(node.getAttribute("data-line-start"), 10) : 1;
      const endLine = node ? parseInt(node.getAttribute("data-line-end"), 10) : startLine;

      openAnnotationModal(
        {
          text: "Architecture Diagram",
          startLine,
          endLine,
          headingContext: "Diagram",
        },
        "comment",
      );
    });
  });
}

// -----------------------------------------------------------------------------
// Table of Contents (TOC) & Reading Stats
// -----------------------------------------------------------------------------
function generateTableOfContents(container: HTMLElement) {
  const tocList = document.getElementById("zen-toc-list");
  const readTimeEl = document.getElementById("zen-read-time");
  if (!tocList) return;

  const headings = Array.from(container.querySelectorAll("h1, h2, h3"));
  const textContent = container.innerText || "";
  const words = textContent.split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.ceil(words / 200));
  if (readTimeEl) readTimeEl.textContent = `~${minutes} min read`;

  if (headings.length === 0) {
    tocList.innerHTML = '<div class="zen-empty-toc">No headings found</div>';
    return;
  }

  tocList.innerHTML = headings
    .map((h, idx) => {
      const depth = parseInt(h.tagName.slice(1), 10);
      const text = h.textContent || `Section ${idx + 1}`;
      const id = h.id || `h-${idx}`;
      if (!h.id) h.id = id;
      return `<a href="#${id}" class="zen-toc-item zen-toc-depth-${depth}" data-heading-id="${id}">${escapeHtml(
        text,
      )}</a>`;
    })
    .join("");

  tocList.querySelectorAll(".zen-toc-item").forEach((link: any) => {
    link.addEventListener("click", (e: MouseEvent) => {
      e.preventDefault();
      const targetId = link.dataset.headingId;
      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
        tocList.querySelectorAll(".zen-toc-item").forEach((l: any) => l.classList.remove("active"));
        link.classList.add("active");
      }
    });
  });

  // Scroll spy on canvas
  const canvas = document.getElementById("zen-canvas");
  if (canvas) {
    canvas.addEventListener("scroll", () => {
      const scrollPos = canvas.scrollTop + 80;
      let activeId = "";
      for (const h of headings) {
        const top = (h as HTMLElement).offsetTop;
        if (scrollPos >= top) {
          activeId = h.id;
        }
      }
      if (activeId) {
        tocList.querySelectorAll(".zen-toc-item").forEach((l: any) => {
          if (l.dataset.headingId === activeId) l.classList.add("active");
          else l.classList.remove("active");
        });
      }
    });
  }
}

// -----------------------------------------------------------------------------
// Ghost Diffs Highlighting
// -----------------------------------------------------------------------------
function applyDiffHighlights() {
  const container = document.getElementById("zen-document-view");
  const diffToggleBtn = document.getElementById("zen-diff-toggle");
  const diffCountEl = document.getElementById("zen-diff-count");
  if (!container) return;

  // Clear existing diff classes
  container.querySelectorAll(".zen-diff-added, .zen-diff-modified").forEach((el: any) => {
    el.classList.remove("zen-diff-added", "zen-diff-modified");
  });

  if (!activeDiffs || activeDiffs.length === 0 || !diffsVisible) {
    if (diffToggleBtn) diffToggleBtn.style.display = "none";
    return;
  }

  if (diffToggleBtn && diffCountEl) {
    diffToggleBtn.style.display = "inline-flex";
    diffCountEl.textContent = String(activeDiffs.length);
  }

  container.querySelectorAll("[data-line-start]").forEach((el: any) => {
    const startLine = parseInt(el.getAttribute("data-line-start") || "1", 10);
    const endLine = parseInt(el.getAttribute("data-line-end") || String(startLine), 10);

    for (const diff of activeDiffs) {
      if (startLine <= diff.endLine && endLine >= diff.startLine) {
        if (diff.type === "added") el.classList.add("zen-diff-added");
        else el.classList.add("zen-diff-modified");
        break;
      }
    }
  });
}

// -----------------------------------------------------------------------------
// Margin Pin Indicators
// -----------------------------------------------------------------------------
function renderMarginPins() {
  const container = document.getElementById("zen-document-view");
  if (!container) return;

  // Remove existing pins
  container.querySelectorAll(".zen-margin-pin").forEach((p) => p.remove());

  for (const item of queuedPrompts) {
    if (item.target?.type === "markdown-range" && item.target.startLine) {
      const line = item.target.startLine;
      const targetEl = container.querySelector(`[data-line-start="${line}"]`) as HTMLElement;
      if (targetEl) {
        const pin = document.createElement("div");
        pin.className = `zen-margin-pin ${
          item.tag === "suggestion" ? "zen-margin-pin-suggestion" : ""
        }`;
        pin.textContent = item.tag === "suggestion" ? "✏️" : "💬";
        pin.title = `[${item.tag.toUpperCase()}] ${item.text}`;
        pin.addEventListener("click", () => {
          showToast(`Feedback on line ${line}: "${item.text.slice(0, 50)}..."`);
        });
        targetEl.appendChild(pin);
      }
    }
  }
}

// -----------------------------------------------------------------------------
// HTML Iframe Inspector
// -----------------------------------------------------------------------------
function setupIframeInspector() {
  const iframe = document.getElementById("zen-iframe") as HTMLIFrameElement;
  if (!iframe) return;

  iframe.onload = () => {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) return;

      doc.addEventListener("click", (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (!target || target === doc.body) return;

        e.preventDefault();
        e.stopPropagation();

        const tagName = target.tagName.toLowerCase();
        const id = target.id ? `#${target.id}` : "";
        const cls = target.className ? `.${target.className.split(/\s+/)[0]}` : "";
        const selector = `${tagName}${id}${cls}`;
        const preview = target.textContent?.slice(0, 60) || selector;

        openAnnotationModal(
          {
            text: preview,
            startLine: 1,
            endLine: 1,
            headingContext: `Element <${selector}>`,
          },
          "comment",
        );
      });
    } catch {
      // Cross-origin iframe restrictions
    }
  };
}

// -----------------------------------------------------------------------------
// Workspace Multi-Document Loading
// -----------------------------------------------------------------------------
async function loadWorkspaceList() {
  if (!sessionKey) return;
  try {
    const res = await fetch(`/api/${sessionKey}/workspace`);
    if (!res.ok) return;
    const data = await res.json();
    const select = document.getElementById("zen-workspace-select") as HTMLSelectElement;

    if (select && data.files && data.files.length > 1) {
      select.style.display = "inline-block";
      select.innerHTML = data.files
        .map(
          (f: any) =>
            `<option value="${escapeHtml(f.relPath)}" ${
              f.relPath === currentFilePath ? "selected" : ""
            }>📄 ${escapeHtml(f.relPath)}</option>`,
        )
        .join("");

      select.onchange = () => {
        loadDocument(select.value);
      };
    }
  } catch {
    // Single-file mode
  }
}

// -----------------------------------------------------------------------------
// Live Reload & Presence via Server-Sent Events (SSE)
// -----------------------------------------------------------------------------
function setupEventStream() {
  if (!sessionKey) return;
  const es = new EventSource(`/events/${sessionKey}`);

  es.addEventListener("reload", (e: MessageEvent) => {
    showToast("⟳ File updated on disk. Re-rendering...");
    try {
      const data = JSON.parse(e.data);
      if (data.diffs) {
        activeDiffs = data.diffs;
      }
    } catch {
      // Ignore
    }
    loadDocument(currentFilePath);
  });

  es.addEventListener("diff", (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      if (data.diffs) {
        activeDiffs = data.diffs;
        applyDiffHighlights();
      }
    } catch {
      // Ignore
    }
  });

  es.addEventListener("presence", (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      updatePresence(data.presence);
    } catch (err) {
      console.debug("SSE presence parse error", err);
    }
  });

  es.addEventListener("progress", (e: MessageEvent) => {
    try {
      const prog = JSON.parse(e.data);
      updateProgressTelemetry(prog);
    } catch (err) {
      console.debug("SSE progress parse error", err);
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
    // EventSource auto reconnects
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

function updateProgressTelemetry(prog: any) {
  const liveProgressEl = document.getElementById("zen-live-progress");
  const stepEl = document.getElementById("zen-progress-step");
  if (!liveProgressEl || !stepEl) return;

  if (prog.status === "running") {
    liveProgressEl.style.display = "flex";
    stepEl.textContent = prog.step;
  } else {
    liveProgressEl.style.display = "none";
  }
}

// -----------------------------------------------------------------------------
// Selection & Annotation Handling
// -----------------------------------------------------------------------------
function setupSelectionListeners() {
  const pill = document.getElementById("zen-floating-pill");
  const commentBtn = document.getElementById("zen-pill-comment");
  const suggestBtn = document.getElementById("zen-pill-suggest");
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

    pill.style.top = `${window.scrollY + rect.top - 46}px`;
    pill.style.left = `${window.scrollX + rect.left + rect.width / 2 - 80}px`;
    pill.style.display = "flex";
  });

  commentBtn?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    pill.style.display = "none";
    if (activeHighlight) {
      openAnnotationModal(activeHighlight, "comment");
    }
  });

  suggestBtn?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    pill.style.display = "none";
    if (activeHighlight) {
      openAnnotationModal(activeHighlight, "suggest");
    }
  });
}

function openAnnotationModal(
  data: {
    text: string;
    startLine: number;
    endLine: number;
    headingContext?: string;
  },
  mode: "comment" | "suggest" = "comment",
) {
  const modal = document.getElementById("zen-modal");
  const quoteEl = document.getElementById("zen-modal-quote");
  const badgeEl = document.getElementById("zen-modal-line-badge");
  const inputEl = document.getElementById("zen-modal-input") as HTMLTextAreaElement;
  const suggestInputEl = document.getElementById("zen-modal-suggest-input") as HTMLTextAreaElement;
  const commentTab = document.getElementById("zen-tab-comment");
  const suggestTab = document.getElementById("zen-tab-suggest");
  const commentModeDiv = document.getElementById("zen-modal-comment-mode");
  const suggestModeDiv = document.getElementById("zen-modal-suggest-mode");

  if (!modal || !quoteEl || !badgeEl || !inputEl || !suggestInputEl) return;

  activeHighlight = data;
  modalMode = mode;
  quoteEl.textContent = `"${data.text}"`;
  badgeEl.textContent = `Lines ${data.startLine}-${data.endLine}`;
  inputEl.value = "";
  suggestInputEl.value = data.text;

  if (mode === "suggest") {
    commentTab?.classList.remove("active");
    suggestTab?.classList.add("active");
    if (commentModeDiv) commentModeDiv.style.display = "none";
    if (suggestModeDiv) suggestModeDiv.style.display = "block";
    setTimeout(() => suggestInputEl.focus(), 50);
  } else {
    suggestTab?.classList.remove("active");
    commentTab?.classList.add("active");
    if (suggestModeDiv) suggestModeDiv.style.display = "none";
    if (commentModeDiv) commentModeDiv.style.display = "block";
    setTimeout(() => inputEl.focus(), 50);
  }

  modal.style.display = "flex";
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
  renderMarginPins();
}

function queueOrReplacePrompt(item: PromptItem) {
  if (item.queueKey) {
    const idx = queuedPrompts.findIndex((p) => p.queueKey === item.queueKey);
    if (idx !== -1) {
      queuedPrompts[idx] = item;
      renderQueue();
      renderMarginPins();
      return;
    }
  }
  queuedPrompts.push(item);
  renderQueue();
  renderMarginPins();
}

function renderQueue() {
  const listEl = document.getElementById("zen-queue-list");
  const countEl = document.getElementById("zen-queue-count");
  if (!listEl || !countEl) return;

  countEl.textContent = String(queuedPrompts.length);

  if (queuedPrompts.length === 0) {
    listEl.innerHTML =
      '<div class="zen-empty-queue">Highlight text to comment or suggest edits, or answer interactive decision cards.</div>';
    return;
  }

  listEl.innerHTML = queuedPrompts
    .map((p, idx) => {
      const lineInfo = p.target?.startLine
        ? `Lines ${p.target.startLine}-${p.target.endLine || p.target.startLine}`
        : "General";

      if (p.tag === "suggestion" && p.target?.replacementText) {
        return `
        <div class="zen-queue-card zen-queue-card-suggestion">
          <div class="zen-queue-card-meta zen-queue-card-meta-suggestion">
            <span>✏️ [SUGGESTION] ${lineInfo}</span>
            <button type="button" class="zen-queue-remove-btn" data-idx="${idx}" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:0.9rem;">✕</button>
          </div>
          <div class="zen-suggestion-diff">
            <div class="zen-suggestion-old">- ${escapeHtml(p.target.selectedText || "")}</div>
            <div class="zen-suggestion-new">+ ${escapeHtml(p.target.replacementText)}</div>
          </div>
        </div>`;
      }

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
      renderMarginPins();
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
    renderMarginPins();
  } catch (err: any) {
    console.error("Send prompts error:", err);
    showToast(`Failed to send prompts: ${err.message}`);
  }
}

// -----------------------------------------------------------------------------
// Copy As Prompt
// -----------------------------------------------------------------------------
function copyQueueAsPrompt() {
  if (queuedPrompts.length === 0) {
    showToast("No feedback items in queue to copy.");
    return;
  }

  let formatted = `### Human Reviewer Feedback for \`${currentFilePath}\`:\n\n`;
  for (const item of queuedPrompts) {
    const lineInfo = item.target?.startLine
      ? `(Lines ${item.target.startLine}-${item.target.endLine || item.target.startLine})`
      : "";
    if (item.tag === "suggestion" && item.target?.replacementText) {
      formatted += `* **Suggestion** ${lineInfo}:\n  - Original: "${item.target.selectedText}"\n  - Replacement: "${item.target.replacementText}"\n`;
    } else {
      formatted += `* **${item.tag.toUpperCase()}** ${lineInfo}: ${item.text}\n`;
    }
  }

  navigator.clipboard.writeText(formatted);
  showToast("✓ Copied formatted feedback prompt to clipboard!");
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
  const toggleTheme = () => {
    const html = document.documentElement;
    const current = html.getAttribute("data-theme") || "dark";
    const next = current === "dark" ? "light" : "dark";
    html.setAttribute("data-theme", next);
    localStorage.setItem("zen-theme", next);
  };
  document.getElementById("zen-theme-toggle")?.addEventListener("click", toggleTheme);

  // Diff Toggle
  document.getElementById("zen-diff-toggle")?.addEventListener("click", () => {
    diffsVisible = !diffsVisible;
    applyDiffHighlights();
    showToast(`Diff highlights: ${diffsVisible ? "Enabled" : "Disabled"}`);
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
  const toggleSidebar = () => {
    const sidebar = document.getElementById("zen-sidebar");
    if (sidebar) {
      sidebar.style.display = sidebar.style.display === "none" ? "flex" : "none";
    }
  };
  document.getElementById("zen-toggle-sidebar")?.addEventListener("click", toggleSidebar);

  // Shortcuts Modal
  const shortcutsModal = document.getElementById("zen-shortcuts-modal");
  document.getElementById("zen-shortcuts-btn")?.addEventListener("click", () => {
    if (shortcutsModal) shortcutsModal.style.display = "flex";
  });
  document.getElementById("zen-close-shortcuts")?.addEventListener("click", () => {
    if (shortcutsModal) shortcutsModal.style.display = "none";
  });

  // Copy as Prompt
  document.getElementById("zen-copy-prompt-btn")?.addEventListener("click", copyQueueAsPrompt);

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

  // Modal Tabs (Comment vs Suggestion)
  const commentTab = document.getElementById("zen-tab-comment");
  const suggestTab = document.getElementById("zen-tab-suggest");
  const commentModeDiv = document.getElementById("zen-modal-comment-mode");
  const suggestModeDiv = document.getElementById("zen-modal-suggest-mode");

  commentTab?.addEventListener("click", () => {
    modalMode = "comment";
    suggestTab?.classList.remove("active");
    commentTab?.classList.add("active");
    if (suggestModeDiv) suggestModeDiv.style.display = "none";
    if (commentModeDiv) commentModeDiv.style.display = "block";
  });

  suggestTab?.addEventListener("click", () => {
    modalMode = "suggest";
    commentTab?.classList.remove("active");
    suggestTab?.classList.add("active");
    if (commentModeDiv) commentModeDiv.style.display = "none";
    if (suggestModeDiv) suggestModeDiv.style.display = "block";
  });

  // Modal Cancel & Submit
  document.getElementById("zen-modal-cancel")?.addEventListener("click", closeAnnotationModal);
  document.getElementById("zen-modal-submit")?.addEventListener("click", () => {
    if (!activeHighlight) {
      closeAnnotationModal();
      return;
    }

    if (modalMode === "suggest") {
      const suggestInput = document.getElementById(
        "zen-modal-suggest-input",
      ) as HTMLTextAreaElement;
      const replacementText = suggestInput?.value.trim();
      if (!replacementText) {
        showToast("Please provide replacement text for suggestion.");
        return;
      }

      queuePrompt({
        id: `sug-${Date.now()}`,
        tag: "suggestion",
        text: `Suggest replacing "${activeHighlight.text}" with "${replacementText}"`,
        target: {
          type: "markdown-range",
          startLine: activeHighlight.startLine,
          endLine: activeHighlight.endLine,
          selectedText: activeHighlight.text,
          replacementText,
          headingContext: activeHighlight.headingContext,
        },
        createdAt: new Date().toISOString(),
      });
      showToast(
        `✓ Suggestion queued for lines ${activeHighlight.startLine}-${activeHighlight.endLine}`,
      );
    } else {
      const input = document.getElementById("zen-modal-input") as HTMLTextAreaElement;
      const text = input?.value.trim();
      if (!text) {
        showToast("Please enter feedback before queueing.");
        return;
      }

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
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
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

  // Global Keyboard Shortcuts
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    // Dismiss modals with Esc
    if (e.key === "Escape") {
      closeAnnotationModal();
      if (shortcutsModal) shortcutsModal.style.display = "none";
      return;
    }

    // Submit with Cmd+Enter or Ctrl+Enter
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendPrompts(false);
      return;
    }

    // Don't trigger single-key shortcuts if inside an active input or textarea
    const activeEl = document.activeElement;
    if (
      activeEl &&
      (activeEl.tagName === "INPUT" ||
        activeEl.tagName === "TEXTAREA" ||
        activeEl.getAttribute("contenteditable") === "true")
    ) {
      return;
    }

    if (e.key === "c" || e.key === "C") {
      if (activeHighlight) {
        e.preventDefault();
        openAnnotationModal(activeHighlight, "comment");
      }
    } else if (e.key === "s" || e.key === "S") {
      if (activeHighlight) {
        e.preventDefault();
        openAnnotationModal(activeHighlight, "suggest");
      }
    } else if (e.key === "t" || e.key === "T") {
      e.preventDefault();
      toggleTheme();
    } else if (e.key === "b" || e.key === "B") {
      e.preventDefault();
      toggleSidebar();
    } else if (e.key === "?") {
      e.preventDefault();
      if (shortcutsModal) shortcutsModal.style.display = "flex";
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

  const savedTheme = localStorage.getItem("zen-theme") || "dark";
  document.documentElement.setAttribute("data-theme", savedTheme);

  setupUiListeners();
  setupSelectionListeners();
  setupEventStream();
  loadWorkspaceList();
  loadDocument();
}

window.addEventListener("DOMContentLoaded", init);
