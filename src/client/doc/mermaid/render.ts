/** Lazy Mermaid: the library loads on the first diagram, and renders run one at a time. */
type Mermaid = typeof import("mermaid").default;

let loading: Promise<Mermaid> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;

const DARK_VARIABLES = {
  background: "#161b22",
  primaryColor: "#21262d",
  primaryBorderColor: "#30363d",
  primaryTextColor: "#f0f6fc",
  lineColor: "#3b82f6",
  textColor: "#f0f6fc",
};

/** Renders a diagram to SVG. `securityLevel: "strict"` makes Mermaid sanitize labels. */
export function renderMermaid(code: string, dark: boolean): Promise<string> {
  const job = queue.then(async () => {
    const mermaid = await (loading ??= import("mermaid").then((m) => m.default));
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
      themeVariables: dark ? DARK_VARIABLES : {},
    });
    const { svg } = await mermaid.render(`zen-mermaid-${++counter}`, code);
    return svg;
  });
  queue = job.catch(() => undefined);
  return job;
}
