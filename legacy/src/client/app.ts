/**
 * Zen AXI Browser Client Logic
 */
import {
  PromptItem,
  DiffRange,
  DocType,
  PromptTag,
  DiffType,
  TargetType,
  AgentPresence,
  ServerEvent,
  ActorRole,
  ProgressStatus,
  PromptItemStatus,
} from "../types.js";

let sessionKey = "";
let currentFilePath = "";
let queuedPrompts: PromptItem[] = [];
let submittedPrompts: PromptItem[] = [];
let resolvedPrompts: PromptItem[] = [];
let workspaceFiles: any[] = [];
let activeDiffs: DiffRange[] = [];
let diffsVisible = true;
let modalMode: "comment" | "suggest" = "comment";

let activeHighlight: {
  text: string;
  startLine: number;
  endLine: number;
  headingContext?: string;
} | null = null;

let activeEventSource: EventSource | null = null;
let isRecovering = false;
let recoveryTimeout: ReturnType<typeof setTimeout> | null = null;

function extractSessionKey(): string {
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  if (pathParts[0] === "session" && pathParts[1]) {
    return pathParts[1];
  }
  const params = new URLSearchParams(window.location.search);
  return params.get("key") || "";
}

function updateApprovalState(isApproved: boolean, approvedAt?: string) {
  const approveBtn = document.getElementById("zen-approve-btn") as HTMLButtonElement | null;
  if (!approveBtn) return;
  if (isApproved) {
    approveBtn.classList.add("zen-btn-approved");
    approveBtn.innerHTML = "✓ Plan Approved";
    const dateStr = approvedAt ? new Date(approvedAt).toLocaleTimeString() : "recently";
    approveBtn.title = `Plan approved at ${dateStr}. Agent is authorized to implement.`;
  } else {
    approveBtn.classList.remove("zen-btn-approved");
    approveBtn.innerHTML = "✅ Approve Plan";
    approveBtn.title = "Approve Plan & Authorize Implementation (a)";
  }
}

// -----------------------------------------------------------------------------
// Document Loading and Rendering
// -----------------------------------------------------------------------------
async function loadDocument(targetRelFile?: string, isHotReload = false) {
  if (!sessionKey) return;
  const canvas = document.getElementById("zen-canvas");
  const savedScrollTop = canvas?.scrollTop ?? 0;

  try {
    const url = targetRelFile
      ? `/api/${sessionKey}/document?file=${encodeURIComponent(targetRelFile)}`
      : `/api/${sessionKey}/document`;

    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 404) {
        const recovered = await autoRecoverSession(targetRelFile);
        if (recovered) return;
      }
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();

    currentFilePath = data.file;

    // Update Header
    const fileNameEl = document.getElementById("zen-file-name");
    const docTypeEl = document.getElementById("zen-doc-type");
    if (fileNameEl) fileNameEl.textContent = data.file;
    if (docTypeEl) docTypeEl.textContent = data.docType.toUpperCase();

    // Update Approval State
    updateApprovalState(Boolean(data.approved), data.approvedAt);

    // Update prompts, submitted, and resolved items
    queuedPrompts = data.queuedPrompts || [];
    submittedPrompts =
      data.submittedPrompts ||
      (data.promptHistory || []).filter((p: any) => p.status === "submitted");
    resolvedPrompts =
      data.resolvedPrompts ||
      (data.promptHistory || []).filter((p: any) => p.status === "resolved");

    // Render Canvas
    const container = document.getElementById("zen-document-view");
    if (!container) return;

    if (data.docType === DocType.Markdown) {
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
          const runPromise = (window as any).mermaid.run({
            nodes: container.querySelectorAll(".mermaid"),
          });
          if (runPromise && typeof runPromise.then === "function") {
            runPromise
              .then(() => {
                setupDiagramZoom(container);
              })
              .catch((err: any) => {
                console.warn("Mermaid run error:", err);
              });
          }
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

    // Restore scroll position on hot reload
    if (isHotReload && canvas) {
      canvas.scrollTop = savedScrollTop;
    }

    // Render Queue and Resolved Feedback
    renderQueue();
    renderResolved();

    // Render Margin Comment Pin Indicators
    renderMarginPins();

    // Render Chat History
    renderChat(data.chatHistory || []);

    // Refresh active state in Workspace File Explorer
    renderWorkspaceList();
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
            tag: PromptTag.Question,
            text: `Rating for "${title}": ${val}/5 Stars`,
            target: {
              type: TargetType.MarkdownRange,
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
          tag: PromptTag.Question,
          text: `Answers to "${title}": ${selectedVals.join(", ")}`,
          target: {
            type: TargetType.MarkdownRange,
            startLine: line,
            endLine: line,
            selectedText: selectedVals.join(", "),
          },
          createdAt: new Date().toISOString(),
        });
      }
    };

    const customCard = qContainer.querySelector(".zen-option-custom") as HTMLElement | null;
    const customInput = qContainer.querySelector(
      ".zen-option-custom-input",
    ) as HTMLInputElement | null;
    const customOptionInput = customCard?.querySelector(
      'input[type="radio"], input[type="checkbox"]',
    ) as HTMLInputElement | null;

    const activateCustomInput = () => {
      if (!isMulti) {
        qContainer
          .querySelectorAll(".zen-option-card:not(.zen-option-custom)")
          .forEach((c: any) => {
            c.classList.remove("selected");
            const r = c.querySelector('input[type="radio"]') as HTMLInputElement;
            if (r) r.checked = false;
          });
      }
      if (customCard) customCard.classList.add("selected");
      if (customOptionInput) customOptionInput.checked = true;
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
          qContainer.querySelectorAll(".zen-option-card").forEach((c: any) => {
            c.classList.remove("selected");
            const r = c.querySelector('input[type="radio"]') as HTMLInputElement;
            if (r) r.checked = false;
          });
          card.classList.add("selected");
          if (input) input.checked = true;

          // Clear custom input when switching to a curated proposal
          if (customInput) customInput.value = "";
          if (customOptionInput) customOptionInput.checked = false;

          queueOrReplacePrompt({
            id: `q-${questionId}`,
            queueKey: `question-${questionId}`,
            tag: PromptTag.Question,
            text: `Answer to "${title}": ${val}`,
            target: {
              type: TargetType.MarkdownRange,
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
    if (customCard && customInput) {
      customCard.addEventListener("click", (e: MouseEvent) => {
        if (e.target !== customInput) {
          customInput.focus();
        }
        activateCustomInput();
      });

      customInput.addEventListener("focus", () => {
        activateCustomInput();
      });

      customInput.addEventListener("input", () => {
        const val = customInput.value.trim();
        if (!val) {
          customCard.classList.remove("selected");
          if (customOptionInput) customOptionInput.checked = false;
          if (isMulti) {
            updateMultiSelections();
          } else {
            const existingIdx = queuedPrompts.findIndex(
              (p) => p.queueKey === `question-${questionId}`,
            );
            if (existingIdx !== -1) {
              queuedPrompts.splice(existingIdx, 1);
              renderQueue();
              renderMarginPins();
            }
          }
          return;
        }

        activateCustomInput();
        if (isMulti) {
          updateMultiSelections();
        } else {
          queueOrReplacePrompt({
            id: `q-${questionId}`,
            queueKey: `question-${questionId}`,
            tag: PromptTag.Question,
            text: `Answer to "${title}": ${val}`,
            target: {
              type: TargetType.MarkdownRange,
              startLine: line,
              endLine: line,
              selectedText: val,
            },
            createdAt: new Date().toISOString(),
          });
        }
      });
    }

    // Auto-queue initial pre-selected default options if not already queued or in history
    const existingQueueItem = queuedPrompts.find((p) => p.queueKey === `question-${questionId}`);
    const isAlreadyInHistory =
      submittedPrompts.some((p) => p.queueKey === `question-${questionId}`) ||
      resolvedPrompts.some((p) => p.queueKey === `question-${questionId}`);

    if (!existingQueueItem && !isAlreadyInHistory) {
      if (isMulti) {
        const initialSelected: string[] = [];
        qContainer
          .querySelectorAll(".zen-option-card.selected:not(.zen-option-custom)")
          .forEach((c: any) => {
            const val = c.dataset.value || c.querySelector(".zen-option-text")?.textContent?.trim();
            if (val) initialSelected.push(val);
          });
        if (initialSelected.length > 0) {
          queueOrReplacePrompt({
            id: `q-${questionId}`,
            queueKey: `question-${questionId}`,
            tag: PromptTag.Question,
            text: `Answers to "${title}": ${initialSelected.join(", ")}`,
            target: {
              type: TargetType.MarkdownRange,
              startLine: line,
              endLine: line,
              selectedText: initialSelected.join(", "),
            },
            createdAt: new Date().toISOString(),
          });
        }
      } else {
        const initialCard = qContainer.querySelector(
          ".zen-option-card.selected:not(.zen-option-custom)",
        ) as HTMLElement | null;
        if (initialCard) {
          const val =
            initialCard.dataset.value ||
            initialCard.querySelector(".zen-option-text")?.textContent?.trim() ||
            "";
          if (val) {
            queueOrReplacePrompt({
              id: `q-${questionId}`,
              queueKey: `question-${questionId}`,
              tag: PromptTag.Question,
              text: `Answer to "${title}": ${val}`,
              target: {
                type: TargetType.MarkdownRange,
                startLine: line,
                endLine: line,
                selectedText: val,
              },
              createdAt: new Date().toISOString(),
            });
          }
        }
      }
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
// Diagram Listeners, Zoom & Lightbox
// -----------------------------------------------------------------------------
let lbZoom = 1.0;
let lbPanX = 0;
let lbPanY = 0;
let lbIsDragging = false;
let lbStartX = 0;
let lbStartY = 0;
let lbInitialPanX = 0;
let lbInitialPanY = 0;

function updateLightboxTransform(smooth = true) {
  const canvas = document.getElementById("zen-lightbox-canvas");
  const badge = document.getElementById("zen-lightbox-zoom-badge");
  if (!canvas) return;
  canvas.style.transition = smooth ? "transform 0.15s ease-out" : "none";
  canvas.style.transform = `translate(${lbPanX}px, ${lbPanY}px) scale(${lbZoom})`;
  if (badge) {
    badge.textContent = `${Math.round(lbZoom * 100)}%`;
  }
}

function getSvgDimensions(svg: SVGElement): { width: number; height: number } {
  const viewBox = svg.getAttribute("viewBox");
  if (viewBox) {
    const parts = viewBox
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }
  const rect = svg.getBoundingClientRect();
  const w = svg.clientWidth || rect.width || 800;
  const h = svg.clientHeight || rect.height || 600;
  return { width: w, height: h };
}

function fitLightboxDiagram() {
  const viewport = document.getElementById("zen-lightbox-viewport");
  const canvas = document.getElementById("zen-lightbox-canvas");
  const svg = canvas?.querySelector("svg") as SVGElement | null;
  if (!viewport || !svg) return;

  const vpRect = viewport.getBoundingClientRect();
  const { width: naturalWidth, height: naturalHeight } = getSvgDimensions(svg);

  lbPanX = 0;
  lbPanY = 0;

  const availW = Math.max(vpRect.width - 80, 200);
  const availH = Math.max(vpRect.height - 80, 200);

  const scaleW = availW / naturalWidth;
  const scaleH = availH / naturalHeight;
  const fitScale = Math.min(scaleW, scaleH, 2.5);

  lbZoom = Math.max(Math.round(fitScale * 100) / 100, 0.25);
  updateLightboxTransform(true);
}

function openDiagramLightbox(mermaidContainer: HTMLElement) {
  const lightbox = document.getElementById("zen-diagram-lightbox");
  const canvas = document.getElementById("zen-lightbox-canvas");
  const titleEl = document.getElementById("zen-lightbox-title");
  if (!lightbox || !canvas) return;

  const sourceCanvas = mermaidContainer.querySelector(".zen-diagram-canvas");
  const svg = sourceCanvas?.querySelector("svg");

  canvas.innerHTML = "";
  if (svg) {
    const clone = svg.cloneNode(true) as SVGElement;
    const { width, height } = getSvgDimensions(svg);
    clone.setAttribute("width", `${width}px`);
    clone.setAttribute("height", `${height}px`);
    clone.style.width = `${width}px`;
    clone.style.height = `${height}px`;
    clone.style.maxWidth = "none";
    clone.style.maxHeight = "none";
    clone.style.display = "block";
    canvas.appendChild(clone);
  } else if (sourceCanvas) {
    canvas.innerHTML = sourceCanvas.innerHTML;
  }

  // Derive title from context if possible
  const prevHeading =
    mermaidContainer.closest("section")?.querySelector("h1, h2, h3, h4") ||
    mermaidContainer.previousElementSibling?.closest("h1, h2, h3, h4");
  if (titleEl) {
    titleEl.textContent = prevHeading
      ? `${prevHeading.textContent} (Diagram)`
      : "Mermaid Architecture Diagram";
  }

  lightbox.style.display = "flex";
  document.body.style.overflow = "hidden";

  requestAnimationFrame(() => {
    fitLightboxDiagram();
  });
}

function closeDiagramLightbox() {
  const lightbox = document.getElementById("zen-diagram-lightbox");
  if (!lightbox || lightbox.style.display === "none") return;
  lightbox.style.display = "none";
  document.body.style.overflow = "";
}

function initDiagramSizing(mContainer: HTMLElement) {
  const viewport = mContainer.querySelector(".zen-diagram-viewport") as HTMLElement | null;
  const canvas = mContainer.querySelector(".zen-diagram-canvas") as HTMLElement | null;
  if (!viewport || !canvas) return;

  const svg = canvas.querySelector("svg") as SVGElement | null;
  const pre = canvas.querySelector("pre.mermaid") as HTMLElement | null;
  if (!svg) return;

  const { width: naturalWidth, height: naturalHeight } = getSvgDimensions(svg);
  if (naturalWidth > 0 && naturalHeight > 0) {
    if (pre) {
      pre.style.maxWidth = "none";
      pre.style.width = "auto";
      pre.style.display = "flex";
      pre.style.justifyContent = "center";
      pre.style.alignItems = "center";
    }
    svg.setAttribute("width", `${naturalWidth}px`);
    svg.setAttribute("height", `${naturalHeight}px`);
    svg.style.width = `${naturalWidth}px`;
    svg.style.height = `${naturalHeight}px`;
    svg.style.maxWidth = "none";
    svg.style.maxHeight = "none";
    svg.style.display = "block";

    const vpWidth = viewport.clientWidth || viewport.getBoundingClientRect().width || 800;
    const availW = Math.max(vpWidth - 48, 100);
    const fitScale = Math.min(availW / naturalWidth, 1.0);
    const targetEl = pre || svg;
    targetEl.style.transform = `scale(${fitScale})`;
    targetEl.style.transformOrigin = "center center";
  }
}

function setupDiagramZoom(container: HTMLElement) {
  container.querySelectorAll(".zen-mermaid-container").forEach((mContainerEl: any) => {
    const mContainer = mContainerEl as HTMLElement;
    initDiagramSizing(mContainer);

    if (mContainer.dataset.zoomInitialized === "true") return;
    mContainer.dataset.zoomInitialized = "true";

    const viewport = mContainer.querySelector(".zen-diagram-viewport") as HTMLElement;
    const canvas = mContainer.querySelector(".zen-diagram-canvas") as HTMLElement;
    const zoomInBtn = mContainer.querySelector('[data-action="zoom-in"]') as HTMLButtonElement;
    const zoomOutBtn = mContainer.querySelector('[data-action="zoom-out"]') as HTMLButtonElement;
    const resetBtns = mContainer.querySelectorAll('[data-action="reset"]');
    const fullscreenBtn = mContainer.querySelector(
      '[data-action="fullscreen"]',
    ) as HTMLButtonElement;
    const zoomBadge = mContainer.querySelector(".zen-diagram-zoom-badge") as HTMLElement;

    if (!viewport || !canvas) return;

    let zoom = 1.0;
    let panX = 0;
    let panY = 0;
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialPanX = 0;
    let initialPanY = 0;

    const updateTransform = (smooth = true) => {
      canvas.style.transition = smooth ? "transform 0.15s ease-out" : "none";
      canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
      if (zoomBadge) {
        zoomBadge.textContent = `${Math.round(zoom * 100)}%`;
      }
    };

    zoomInBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      zoom = Math.min(Math.round((zoom + 0.25) * 100) / 100, 5.0);
      updateTransform(true);
    });

    zoomOutBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      zoom = Math.max(Math.round((zoom - 0.25) * 100) / 100, 0.25);
      updateTransform(true);
    });

    resetBtns.forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        zoom = 1.0;
        panX = 0;
        panY = 0;
        initDiagramSizing(mContainer);
        updateTransform(true);
      });
    });

    fullscreenBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      openDiagramLightbox(mContainer);
    });

    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        if (zoom === 1.0 && panX === 0 && panY === 0) {
          initDiagramSizing(mContainer);
        }
      });
      ro.observe(viewport);
    }

    viewport.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      initialPanX = panX;
      initialPanY = panY;
      viewport.setPointerCapture(e.pointerId);
      viewport.classList.add("is-dragging");
      canvas.style.transition = "none";
    });

    viewport.addEventListener("pointermove", (e: PointerEvent) => {
      if (!isDragging) return;
      panX = initialPanX + (e.clientX - startX);
      panY = initialPanY + (e.clientY - startY);
      updateTransform(false);
    });

    const stopDragging = (e: PointerEvent) => {
      if (!isDragging) return;
      isDragging = false;
      if (viewport.hasPointerCapture(e.pointerId)) {
        viewport.releasePointerCapture(e.pointerId);
      }
      viewport.classList.remove("is-dragging");
      canvas.style.transition = "transform 0.15s ease-out";
    };

    viewport.addEventListener("pointerup", stopDragging);
    viewport.addEventListener("pointercancel", stopDragging);

    // Trackpad pinch or Ctrl + Mouse Wheel zoom
    viewport.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const delta = e.deltaY < 0 ? 0.15 : -0.15;
          zoom = Math.min(Math.max(Math.round((zoom + delta) * 100) / 100, 0.25), 5.0);
          updateTransform(true);
        }
      },
      { passive: false },
    );

    viewport.addEventListener("dblclick", (e: MouseEvent) => {
      e.preventDefault();
      if (zoom !== 1.0 || panX !== 0 || panY !== 0) {
        zoom = 1.0;
        panX = 0;
        panY = 0;
        initDiagramSizing(mContainer);
      } else {
        zoom = 1.5;
      }
      updateTransform(true);
    });
  });
}

function setupLightboxListeners() {
  const lightbox = document.getElementById("zen-diagram-lightbox");
  const viewport = document.getElementById("zen-lightbox-viewport");
  const canvas = document.getElementById("zen-lightbox-canvas");
  const closeBtn = document.getElementById("zen-lightbox-close");
  const zoomInBtn = document.getElementById("zen-lightbox-zoom-in");
  const zoomOutBtn = document.getElementById("zen-lightbox-zoom-out");
  const resetBtn = document.getElementById("zen-lightbox-reset");
  const zoomBadge = document.getElementById("zen-lightbox-zoom-badge");
  const fitBtn = document.getElementById("zen-lightbox-fit");

  closeBtn?.addEventListener("click", closeDiagramLightbox);

  lightbox?.addEventListener("click", (e) => {
    if (e.target === lightbox) {
      closeDiagramLightbox();
    }
  });

  zoomInBtn?.addEventListener("click", () => {
    lbZoom = Math.min(Math.round((lbZoom + 0.25) * 100) / 100, 6.0);
    updateLightboxTransform(true);
  });

  zoomOutBtn?.addEventListener("click", () => {
    lbZoom = Math.max(Math.round((lbZoom - 0.25) * 100) / 100, 0.2);
    updateLightboxTransform(true);
  });

  resetBtn?.addEventListener("click", () => {
    lbZoom = 1.0;
    lbPanX = 0;
    lbPanY = 0;
    updateLightboxTransform(true);
  });

  zoomBadge?.addEventListener("click", () => {
    lbZoom = 1.0;
    lbPanX = 0;
    lbPanY = 0;
    updateLightboxTransform(true);
  });

  fitBtn?.addEventListener("click", () => {
    fitLightboxDiagram();
  });

  if (viewport) {
    viewport.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      lbIsDragging = true;
      lbStartX = e.clientX;
      lbStartY = e.clientY;
      lbInitialPanX = lbPanX;
      lbInitialPanY = lbPanY;
      viewport.setPointerCapture(e.pointerId);
      viewport.classList.add("is-dragging");
      if (canvas) canvas.style.transition = "none";
    });

    viewport.addEventListener("pointermove", (e: PointerEvent) => {
      if (!lbIsDragging) return;
      lbPanX = lbInitialPanX + (e.clientX - lbStartX);
      lbPanY = lbInitialPanY + (e.clientY - lbStartY);
      updateLightboxTransform(false);
    });

    const stopDrag = (e: PointerEvent) => {
      if (!lbIsDragging) return;
      lbIsDragging = false;
      if (viewport.hasPointerCapture(e.pointerId)) {
        viewport.releasePointerCapture(e.pointerId);
      }
      viewport.classList.remove("is-dragging");
      if (canvas) canvas.style.transition = "transform 0.15s ease-out";
    };

    viewport.addEventListener("pointerup", stopDrag);
    viewport.addEventListener("pointercancel", stopDrag);

    viewport.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.15 : -0.15;
        lbZoom = Math.min(Math.max(Math.round((lbZoom + delta) * 100) / 100, 0.2), 6.0);
        updateLightboxTransform(true);
      },
      { passive: false },
    );

    viewport.addEventListener("dblclick", (e: MouseEvent) => {
      e.preventDefault();
      if (lbZoom !== 1.0 || lbPanX !== 0 || lbPanY !== 0) {
        fitLightboxDiagram();
      } else {
        lbZoom = 1.5;
        updateLightboxTransform(true);
      }
    });
  }
}

function setupDiagramListeners(container: HTMLElement) {
  setupDiagramZoom(container);

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

  // Setup dynamic ScrollSpy and Reading Progress on canvas
  setupScrollSpyAndProgress(headings, tocList);
}

let activeScrollSpyCleanup: (() => void) | null = null;

function setupScrollSpyAndProgress(headings: Element[], tocList: HTMLElement) {
  if (activeScrollSpyCleanup) {
    activeScrollSpyCleanup();
    activeScrollSpyCleanup = null;
  }

  const canvas = document.getElementById("zen-canvas");
  const progressBar = document.getElementById("zen-reading-progress");
  if (!canvas) return;

  let ticking = false;

  const updateProgressAndSpy = () => {
    // 1. Reading Progress Bar
    if (progressBar) {
      const maxScroll = canvas.scrollHeight - canvas.clientHeight;
      const pct =
        maxScroll > 0 ? Math.min(100, Math.max(0, (canvas.scrollTop / maxScroll) * 100)) : 0;
      progressBar.style.width = `${pct}%`;
    }

    // 2. ScrollSpy Heading Detection
    if (headings.length === 0) return;

    const canvasRect = canvas.getBoundingClientRect();
    const thresholdY = canvasRect.top + 100; // 100px from top of canvas view

    let currentActiveId = "";
    for (const h of headings) {
      const rect = h.getBoundingClientRect();
      if (rect.top <= thresholdY) {
        currentActiveId = h.id;
      } else {
        break;
      }
    }

    if (!currentActiveId && headings.length > 0) {
      currentActiveId = headings[0].id;
    }

    if (canvas.scrollHeight - canvas.scrollTop - canvas.clientHeight < 40) {
      currentActiveId = headings[headings.length - 1].id;
    }

    if (currentActiveId) {
      let activeItem: HTMLElement | null = null;
      tocList.querySelectorAll(".zen-toc-item").forEach((link: any) => {
        if (link.dataset.headingId === currentActiveId) {
          link.classList.add("active");
          activeItem = link;
        } else {
          link.classList.remove("active");
        }
      });

      if (activeItem) {
        const parent = (activeItem as HTMLElement).parentElement;
        if (parent && parent.scrollHeight > parent.clientHeight) {
          const itemTop = (activeItem as HTMLElement).offsetTop;
          const itemBottom = itemTop + (activeItem as HTMLElement).offsetHeight;
          if (itemTop < parent.scrollTop || itemBottom > parent.scrollTop + parent.clientHeight) {
            parent.scrollTop = itemTop - parent.clientHeight / 2;
          }
        }
      }
    }
  };

  const onScroll = () => {
    if (!ticking) {
      requestAnimationFrame(() => {
        updateProgressAndSpy();
        ticking = false;
      });
      ticking = true;
    }
  };

  canvas.addEventListener("scroll", onScroll, { passive: true });
  updateProgressAndSpy();

  activeScrollSpyCleanup = () => {
    canvas.removeEventListener("scroll", onScroll);
  };
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
        if (diff.type === DiffType.Added) el.classList.add("zen-diff-added");
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
    if (item.target?.type === TargetType.MarkdownRange && item.target.startLine) {
      const line = item.target.startLine;
      const targetEl = container.querySelector(`[data-line-start="${line}"]`) as HTMLElement;
      if (targetEl) {
        const pin = document.createElement("div");
        pin.className = `zen-margin-pin ${
          item.tag === PromptTag.Suggestion ? "zen-margin-pin-suggestion" : ""
        }`;
        pin.textContent = item.tag === PromptTag.Suggestion ? "✏️" : "💬";
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
// Workspace Multi-Document Loading & File Explorer
// -----------------------------------------------------------------------------
async function loadWorkspaceList() {
  if (!sessionKey) return;
  try {
    const res = await fetch(`/api/${sessionKey}/workspace`);
    if (!res.ok) return;
    const data = await res.json();
    workspaceFiles = data.files || [];
    renderWorkspaceList();
  } catch (err) {
    console.debug("Workspace scan error", err);
  }
}

function renderWorkspaceList(filterText = "") {
  const listEl = document.getElementById("zen-files-list");
  const countEl = document.getElementById("zen-files-count");
  if (!listEl) return;

  if (countEl) countEl.textContent = String(workspaceFiles.length);

  const filtered = filterText
    ? workspaceFiles.filter((f) => f.relPath.toLowerCase().includes(filterText.toLowerCase()))
    : workspaceFiles;

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="zen-empty-files">${
      filterText ? "No matching documents found" : "No documents found in workspace"
    }</div>`;
    return;
  }

  listEl.innerHTML = filtered
    .map((f) => {
      const isActive =
        f.relPath === currentFilePath ||
        f.absPath === currentFilePath ||
        (f.sessionKey && f.sessionKey === sessionKey);
      const badgeText = f.docType === "html" ? "HTML" : "MD";
      const statusTags: string[] = [];

      if (f.approved) {
        statusTags.push('<span class="zen-file-tag zen-file-tag-approved">✓ Approved</span>');
      }
      if (f.queuedCount && f.queuedCount > 0) {
        statusTags.push(
          `<span class="zen-file-tag zen-file-tag-pending">💬 ${f.queuedCount}</span>`,
        );
      }

      const dirName = f.relPath.includes("/") ? f.relPath.slice(0, f.relPath.lastIndexOf("/")) : "";
      const fileName = f.relPath.includes("/")
        ? f.relPath.slice(f.relPath.lastIndexOf("/") + 1)
        : f.relPath;

      return `
      <div class="zen-file-card ${isActive ? "active" : ""}" data-relpath="${escapeHtml(
        f.relPath,
      )}" data-key="${f.sessionKey || ""}">
        <div class="zen-file-row">
          <div class="zen-file-title">
            <span class="zen-file-badge">${badgeText}</span>
            <span title="${escapeHtml(f.relPath)}">${escapeHtml(fileName)}</span>
          </div>
          ${statusTags.join("")}
        </div>
        ${
          dirName
            ? `<div class="zen-file-meta" title="${escapeHtml(dirName)}">${escapeHtml(
                dirName,
              )}</div>`
            : ""
        }
      </div>`;
    })
    .join("");

  listEl.querySelectorAll(".zen-file-card").forEach((card: any) => {
    card.addEventListener("click", () => {
      const relPath = card.dataset.relpath;
      const targetKey = card.dataset.key;
      if (relPath) {
        switchDocument(relPath, targetKey);
      }
    });
  });
}

function switchDocument(relPath: string, targetKey?: string) {
  if (targetKey && targetKey !== sessionKey) {
    sessionKey = targetKey;
    window.history.pushState(null, "", `/session/${targetKey}`);
    setupEventStream();
  }
  loadDocument(relPath);
  showToast(`📄 Switched to: ${relPath}`);
}

// -----------------------------------------------------------------------------
// Live Reload & Presence via Server-Sent Events (SSE)
// -----------------------------------------------------------------------------
function setupEventStream() {
  if (!sessionKey) return;
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }

  const es = new EventSource(`/events/${sessionKey}`);
  activeEventSource = es;

  es.addEventListener(ServerEvent.Reload, (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      if (data.diffs) {
        activeDiffs = data.diffs;
      }
    } catch {
      // Ignore
    }
    loadDocument(currentFilePath, true);
    showToast("⚡ Hot reloaded: document updated on disk");
  });

  es.addEventListener(ServerEvent.Diff, (e: MessageEvent) => {
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

  es.addEventListener(ServerEvent.Presence, (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      updatePresence(data.presence);
    } catch (err) {
      console.debug("SSE presence parse error", err);
    }
  });

  es.addEventListener(ServerEvent.Progress, (e: MessageEvent) => {
    try {
      const prog = JSON.parse(e.data);
      updateProgressTelemetry(prog);
    } catch (err) {
      console.debug("SSE progress parse error", err);
    }
  });

  es.addEventListener(ServerEvent.Chat, (e: MessageEvent) => {
    try {
      const msg = JSON.parse(e.data);
      appendChatMessage(msg);
      showToast(`💬 Agent reply: ${msg.text.slice(0, 40)}...`);
    } catch (err) {
      console.debug("SSE chat parse error", err);
    }
  });

  es.addEventListener(ServerEvent.Approved, (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      updateApprovalState(true, data.approvedAt);
      showToast("✅ Plan approved! Agent is authorized to proceed with implementation.");
    } catch (err) {
      console.debug("SSE approved parse error", err);
    }
  });

  es.addEventListener(ServerEvent.Prompts, (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      if (data.history) {
        resolvedPrompts = data.history.filter((p: any) => p.status === "resolved");
        submittedPrompts = data.history.filter((p: any) => p.status === "submitted");
      }
      renderQueue();
      renderResolved();
      renderMarginPins();
    } catch (err) {
      console.debug("SSE prompts parse error", err);
    }
  });

  es.addEventListener(ServerEvent.Workspace, (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      if (data.files) {
        workspaceFiles = data.files;
        renderWorkspaceList();
      }
    } catch (err) {
      console.debug("SSE workspace parse error", err);
    }
  });

  es.addEventListener(ServerEvent.Ended, () => {
    showToast("🛑 Session ended.");
    const endBtn = document.getElementById("zen-end-btn");
    if (endBtn) {
      endBtn.textContent = "Session Ended (Read Only)";
      (endBtn as HTMLButtonElement).disabled = true;
    }
  });

  es.onopen = () => {
    if (recoveryTimeout) {
      clearTimeout(recoveryTimeout);
      recoveryTimeout = null;
    }
  };

  es.onerror = () => {
    // Only attempt recovery if the server actively closed the connection (e.g. 404),
    // and debounce to prevent repeated recovery attempts.
    if (es.readyState === EventSource.CLOSED && !isRecovering) {
      if (recoveryTimeout) clearTimeout(recoveryTimeout);
      recoveryTimeout = setTimeout(async () => {
        await autoRecoverSession();
      }, 1500);
    }
  };
}

async function autoRecoverSession(targetPath?: string): Promise<boolean> {
  if (isRecovering) return false;
  isRecovering = true;
  try {
    const res = await fetch("/api/workspace");
    if (!res.ok) return false;
    const data = await res.json();
    const files = data.files || [];
    if (files.length === 0) return false;

    const queryPath = targetPath || currentFilePath;

    // 1. Try to find the exact file match
    let match = queryPath
      ? files.find((f: any) => f.relPath === queryPath || f.absPath === queryPath)
      : undefined;

    // 2. If single-file workspace with an active session, fallback to that file
    if (!match && !queryPath && files.length === 1 && files[0].sessionKey) {
      match = files[0];
    }

    if (match && match.sessionKey && match.sessionKey !== sessionKey) {
      sessionKey = match.sessionKey;
      if (match.relPath) {
        currentFilePath = match.relPath;
      }
      window.history.replaceState(null, "", `/session/${sessionKey}`);
      setupEventStream();
      loadDocument(currentFilePath, true);
      showToast("⚡ Reconnected to active session");
      return true;
    }
  } catch (err) {
    console.debug("Session auto-recovery failed", err);
  } finally {
    isRecovering = false;
  }
  return false;
}

function updatePresence(presence: string) {
  const chip = document.getElementById("zen-presence");
  const textEl = chip?.querySelector(".zen-presence-text");
  if (!chip || !textEl) return;

  chip.className = `zen-presence-chip zen-presence-${presence}`;
  if (presence === AgentPresence.Listening) {
    textEl.textContent = "Agent listening";
  } else if (presence === AgentPresence.Working) {
    textEl.textContent = "Agent working...";
  } else {
    textEl.textContent = "Waiting for agent";
  }
}

function updateProgressTelemetry(prog: any) {
  const liveProgressEl = document.getElementById("zen-live-progress");
  const stepEl = document.getElementById("zen-progress-step");
  if (!liveProgressEl || !stepEl) return;

  if (prog.status === ProgressStatus.Running) {
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
  const countEl = document.getElementById("zen-pending-count");
  if (!listEl) return;

  if (countEl) countEl.textContent = String(queuedPrompts.length);

  if (queuedPrompts.length === 0 && submittedPrompts.length === 0) {
    listEl.innerHTML =
      '<div class="zen-empty-queue">Highlight text to comment or suggest edits, or answer interactive decision cards.</div>';
    return;
  }

  let html = "";

  // 1. Staged Feedback Section
  if (queuedPrompts.length > 0) {
    if (submittedPrompts.length > 0) {
      html += `<div class="zen-queue-section-header">📝 Staged Feedback (${queuedPrompts.length})</div>`;
    }
    html += queuedPrompts
      .map((p, idx) => {
        const mdTarget = p.target?.type === TargetType.MarkdownRange ? p.target : undefined;
        const lineInfo = mdTarget?.startLine
          ? `Lines ${mdTarget.startLine}-${mdTarget.endLine || mdTarget.startLine}`
          : "General";

        if (p.tag === PromptTag.Suggestion && mdTarget?.replacementText) {
          return `
          <div class="zen-queue-card zen-queue-card-suggestion">
            <div class="zen-queue-card-meta zen-queue-card-meta-suggestion">
              <span>✏️ [SUGGESTION] ${lineInfo}</span>
              <button type="button" class="zen-queue-remove-btn" data-idx="${idx}" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:0.9rem;">✕</button>
            </div>
            <div class="zen-suggestion-diff">
              <div class="zen-suggestion-old">- ${escapeHtml(mdTarget.selectedText || "")}</div>
              <div class="zen-suggestion-new">+ ${escapeHtml(mdTarget.replacementText)}</div>
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
  }

  // 2. In Progress with Agent Section
  if (submittedPrompts.length > 0) {
    html += `<div class="zen-queue-section-header zen-queue-section-inprogress">
      <span>⚡ In Progress with Agent (${submittedPrompts.length})</span>
      <span class="zen-pulse-indicator"><span class="zen-pulse-dot"></span> Active</span>
    </div>`;

    html += submittedPrompts
      .map((p) => {
        const mdTarget = p.target?.type === TargetType.MarkdownRange ? p.target : undefined;
        const lineInfo = mdTarget?.startLine
          ? `Lines ${mdTarget.startLine}-${mdTarget.endLine || mdTarget.startLine}`
          : "General";
        const timeStr = p.createdAt ? new Date(p.createdAt).toLocaleTimeString() : "";

        return `
        <div class="zen-queue-card zen-queue-card-submitted">
          <div class="zen-queue-card-meta">
            <span class="zen-tag-badge">⚡ [${p.tag.toUpperCase()}] ${lineInfo}</span>
            <span class="zen-time-meta">${timeStr}</span>
          </div>
          <div class="zen-queue-card-text">${escapeHtml(p.text)}</div>
          <div class="zen-submitted-status">
            <span class="zen-pulse-dot"></span> Dispatched to agent - awaiting disk updates
          </div>
        </div>`;
      })
      .join("");
  }

  listEl.innerHTML = html;

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

function renderResolved() {
  const listEl = document.getElementById("zen-resolved-list");
  const countEl = document.getElementById("zen-resolved-count");
  if (!listEl) return;

  if (countEl) countEl.textContent = String(resolvedPrompts.length);

  if (resolvedPrompts.length === 0) {
    listEl.innerHTML =
      '<div class="zen-empty-resolved">No resolved questions or comments yet. When the agent applies modifications or replies, they will appear here with jump links to the changed lines.</div>';
    return;
  }

  listEl.innerHTML = resolvedPrompts
    .map((p) => {
      const mdTarget = p.target?.type === TargetType.MarkdownRange ? p.target : undefined;
      const targetLine = p.resolution?.startLine || mdTarget?.startLine || 1;
      const endLine = p.resolution?.endLine || mdTarget?.endLine || targetLine;
      const lineInfo = `Lines ${targetLine}${endLine && endLine !== targetLine ? `-${endLine}` : ""}`;

      let resolutionContent = "";
      if (p.resolution?.agentReply) {
        resolutionContent += `<div class="zen-resolved-reply">💬 Agent: ${escapeHtml(
          p.resolution.agentReply,
        )}</div>`;
      }
      if (p.resolution?.diffSummary) {
        resolutionContent += `<div class="zen-resolved-diff-preview">${escapeHtml(
          p.resolution.diffSummary,
        )}</div>`;
      }

      return `
      <div class="zen-resolved-card" data-start="${targetLine}" data-end="${endLine}">
        <div class="zen-resolved-card-meta">
          <span>✓ [${p.tag.toUpperCase()}] ${lineInfo}</span>
          <span style="font-size:0.7rem;color:var(--text-muted);">${
            p.resolvedAt ? new Date(p.resolvedAt).toLocaleTimeString() : "Resolved"
          }</span>
        </div>
        <div class="zen-resolved-question-text">${escapeHtml(p.text)}</div>
        <div class="zen-resolution-banner">
          <div class="zen-resolution-header">
            <span>📍 Modification pointer</span>
            <button type="button" class="zen-jump-btn" data-start="${targetLine}" data-end="${endLine}">
              📍 Jump & Highlight
            </button>
          </div>
          ${resolutionContent}
        </div>
      </div>`;
    })
    .join("");

  listEl.querySelectorAll(".zen-jump-btn, .zen-resolved-card").forEach((el: any) => {
    el.addEventListener("click", (e: MouseEvent) => {
      e.stopPropagation();
      const startLine = parseInt(
        el.dataset.start || el.closest("[data-start]")?.dataset.start || "1",
        10,
      );
      const endLine = parseInt(
        el.dataset.end || el.closest("[data-end]")?.dataset.end || String(startLine),
        10,
      );
      jumpAndHighlightLine(startLine, endLine);
    });
  });
}

function jumpAndHighlightLine(startLine?: number, endLine?: number) {
  const container = document.getElementById("zen-document-view");
  if (!container) return;

  const targetStart = startLine || 1;
  const targetEnd = endLine || targetStart;

  const allLineEls = Array.from(container.querySelectorAll("[data-line-start]")) as HTMLElement[];
  if (allLineEls.length === 0) {
    showToast(`Line ${targetStart} in document.`);
    return;
  }

  // Find all elements whose line range overlaps [targetStart, targetEnd]
  const matchingEls = allLineEls.filter((el) => {
    const sl = parseInt(el.getAttribute("data-line-start") || "0", 10);
    const elEnd = parseInt(el.getAttribute("data-line-end") || String(sl), 10);
    return sl <= targetEnd && elEnd >= targetStart;
  });

  const targetEl =
    matchingEls[0] ||
    allLineEls.find((el) => {
      const sl = parseInt(el.getAttribute("data-line-start") || "0", 10);
      return sl >= targetStart;
    }) ||
    allLineEls[allLineEls.length - 1];

  if (targetEl) {
    targetEl.scrollIntoView({ behavior: "smooth", block: "center" });

    const elsToHighlight = matchingEls.length > 0 ? matchingEls : [targetEl];
    for (const el of elsToHighlight) {
      el.classList.remove("zen-resolved-highlight");
      void el.offsetWidth; // force DOM reflow
      el.classList.add("zen-resolved-highlight");
    }

    setTimeout(() => {
      for (const el of elsToHighlight) {
        el.classList.remove("zen-resolved-highlight");
      }
    }, 2800);

    const lineText =
      targetEnd !== targetStart ? `${targetStart}-${targetEnd}` : String(targetStart);
    showToast(`📍 Highlighted modified lines ${lineText}`);
  } else {
    showToast(`Line ${targetStart} in document.`);
  }
}

async function sendPrompts(shouldEndSession = false) {
  const composerInput = document.getElementById("zen-composer-input") as HTMLTextAreaElement | null;
  if (composerInput && composerInput.value.trim()) {
    const text = composerInput.value.trim();
    queuedPrompts.push({
      id: `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      tag: PromptTag.Chat,
      text,
      createdAt: new Date().toISOString(),
      status: PromptItemStatus.Pending,
    });
    composerInput.value = "";
    renderQueue();
  }

  if (queuedPrompts.length === 0 && !shouldEndSession) {
    showToast("No feedback items queued.");
    return;
  }

  try {
    let res = await fetch(`/api/${sessionKey}/prompts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompts: queuedPrompts,
        endSession: shouldEndSession,
      }),
    });

    if (res.status === 404) {
      const recovered = await autoRecoverSession(currentFilePath);
      if (recovered) {
        res = await fetch(`/api/${sessionKey}/prompts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompts: queuedPrompts,
            endSession: shouldEndSession,
          }),
        });
      }
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const resData = await res.json();

    if (resData.history) {
      resolvedPrompts = resData.history.filter((p: any) => p.status === "resolved");
      submittedPrompts = resData.history.filter((p: any) => p.status === "submitted");
    } else {
      const newlySubmitted = queuedPrompts.map((p) => ({
        ...p,
        status: PromptItemStatus.Submitted,
        createdAt: p.createdAt || new Date().toISOString(),
      }));
      submittedPrompts = [...submittedPrompts, ...newlySubmitted];
    }

    showToast(
      shouldEndSession
        ? "✓ Feedback sent and session concluded."
        : "🚀 Feedback sent to agent. Agent is working...",
    );

    queuedPrompts = [];
    renderQueue();
    renderResolved();
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
    const mdTarget = item.target?.type === TargetType.MarkdownRange ? item.target : undefined;
    const lineInfo = mdTarget?.startLine
      ? `(Lines ${mdTarget.startLine}-${mdTarget.endLine || mdTarget.startLine})`
      : "";
    if (item.tag === PromptTag.Suggestion && mdTarget?.replacementText) {
      formatted += `* **Suggestion** ${lineInfo}:\n  - Original: "${mdTarget.selectedText || ""}"\n  - Replacement: "${mdTarget.replacementText}"\n`;
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

let isFocusMode = false;

function toggleFocusMode(forced?: boolean) {
  isFocusMode = typeof forced === "boolean" ? forced : !isFocusMode;
  const appEl = document.getElementById("zen-app");
  const focusBtn = document.getElementById("zen-focus-toggle");
  const exitPill = document.getElementById("zen-focus-exit-pill");

  if (!appEl) return;

  if (isFocusMode) {
    appEl.classList.add("zen-focus-mode");
    focusBtn?.classList.add("active");
    if (exitPill) exitPill.style.display = "flex";
    showToast("🧘 Focus Reading Mode: ON (press z to exit)");
  } else {
    appEl.classList.remove("zen-focus-mode");
    focusBtn?.classList.remove("active");
    if (exitPill) exitPill.style.display = "none";
    showToast("Focus Reading Mode: OFF");
  }
}

function setupUiListeners() {
  // Focus Mode Toggle
  document.getElementById("zen-focus-toggle")?.addEventListener("click", () => toggleFocusMode());
  document
    .getElementById("zen-focus-exit-pill")
    ?.addEventListener("click", () => toggleFocusMode(false));

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

  // Approve Plan Button
  document.getElementById("zen-approve-btn")?.addEventListener("click", async () => {
    try {
      let res = await fetch(`/api/${sessionKey}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: "Explicitly approved from ZenSpec UI" }),
      });
      if (res.status === 404) {
        const recovered = await autoRecoverSession(currentFilePath);
        if (recovered) {
          res = await fetch(`/api/${sessionKey}/approve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ notes: "Explicitly approved from ZenSpec UI" }),
          });
        }
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      updateApprovalState(true, data.approvedAt);
      showToast("✅ Plan approved! Agent is authorized to proceed with implementation.");
    } catch (e: any) {
      showToast(`Error approving plan: ${e.message}`);
    }
  });

  // End Session Button
  document.getElementById("zen-end-btn")?.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to end this review session?")) return;
    try {
      await fetch(`/api/${sessionKey}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endedBy: ActorRole.User }),
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

  // Left Sidebar Tabs (Documents vs Outline)
  const tabFiles = document.getElementById("zen-tab-files");
  const tabOutline = document.getElementById("zen-tab-outline");
  const filesView = document.getElementById("zen-files-view");
  const outlineView = document.getElementById("zen-outline-view");

  const activateFilesTab = () => {
    tabFiles?.classList.add("active");
    tabOutline?.classList.remove("active");
    if (filesView) filesView.style.display = "flex";
    if (outlineView) outlineView.style.display = "none";
  };

  const activateOutlineTab = () => {
    tabOutline?.classList.add("active");
    tabFiles?.classList.remove("active");
    if (outlineView) outlineView.style.display = "flex";
    if (filesView) filesView.style.display = "none";
  };

  tabFiles?.addEventListener("click", activateFilesTab);
  tabOutline?.addEventListener("click", activateOutlineTab);

  // Documents search filter
  const filterInput = document.getElementById("zen-files-filter") as HTMLInputElement | null;
  filterInput?.addEventListener("input", () => {
    renderWorkspaceList(filterInput.value.trim());
  });

  // Right Sidebar Tabs (Pending vs Resolved)
  const tabPending = document.getElementById("zen-tab-pending");
  const tabResolved = document.getElementById("zen-tab-resolved");
  const queueList = document.getElementById("zen-queue-list");
  const resolvedList = document.getElementById("zen-resolved-list");
  const actionChips = document.getElementById("zen-action-chips");

  tabPending?.addEventListener("click", () => {
    tabPending.classList.add("active");
    tabResolved?.classList.remove("active");
    if (queueList) queueList.style.display = "flex";
    if (actionChips) actionChips.style.display = "flex";
    if (resolvedList) resolvedList.style.display = "none";
  });

  tabResolved?.addEventListener("click", () => {
    tabResolved.classList.add("active");
    tabPending?.classList.remove("active");
    if (resolvedList) resolvedList.style.display = "flex";
    if (queueList) queueList.style.display = "none";
    if (actionChips) actionChips.style.display = "none";
  });

  // Shortcuts Modal
  const shortcutsModal = document.getElementById("zen-shortcuts-modal");
  document.getElementById("zen-shortcuts-btn")?.addEventListener("click", () => {
    if (shortcutsModal) shortcutsModal.style.display = "flex";
  });
  document.getElementById("zen-close-shortcuts")?.addEventListener("click", () => {
    if (shortcutsModal) shortcutsModal.style.display = "none";
  });

  // Diagram Fullscreen Lightbox Modal
  setupLightboxListeners();

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
        tag: PromptTag.Annotation,
        text: promptsMap[action] || "Action requested",
        target: activeHighlight
          ? {
              type: TargetType.MarkdownRange,
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
        tag: PromptTag.Suggestion,
        text: `Suggest replacing "${activeHighlight.text}" with "${replacementText}"`,
        target: {
          type: TargetType.MarkdownRange,
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
        tag: PromptTag.Annotation,
        text,
        target: {
          type: TargetType.MarkdownRange,
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
        tag: PromptTag.Chat,
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
      closeDiagramLightbox();
      return;
    }

    // Lightbox zoom shortcuts
    const lightboxEl = document.getElementById("zen-diagram-lightbox");
    if (lightboxEl && lightboxEl.style.display === "flex") {
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        lbZoom = Math.min(Math.round((lbZoom + 0.25) * 100) / 100, 6.0);
        updateLightboxTransform(true);
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        lbZoom = Math.max(Math.round((lbZoom - 0.25) * 100) / 100, 0.2);
        updateLightboxTransform(true);
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        fitLightboxDiagram();
        return;
      }
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
        activeEl.getAttribute("contenteditable") === "true" ||
        (activeEl as HTMLElement).isContentEditable)
    ) {
      return;
    }

    if ((e.key === "z" || e.key === "Z") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      toggleFocusMode();
    } else if (e.key === "a" || e.key === "A") {
      e.preventDefault();
      document.getElementById("zen-approve-btn")?.click();
    } else if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      activateFilesTab();
    } else if (e.key === "o" || e.key === "O") {
      e.preventDefault();
      activateOutlineTab();
    } else if (e.key === "c" || e.key === "C") {
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
