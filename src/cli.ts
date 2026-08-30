import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import open from "open";
import pc from "picocolors";
import { ZenServer } from "./server.js";
import { SessionStore, sessionKey } from "./session-store.js";
import { renderMarkdownWithSourceLines } from "./sourcemap.js";

const DEFAULT_PORT = 4388;
const DEFAULT_HOST = "127.0.0.1";

const __filename = fileURLToPath(import.meta.url);

async function isServerRunning(port = DEFAULT_PORT, host = DEFAULT_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function startServerDaemon(port = DEFAULT_PORT, host = DEFAULT_HOST): Promise<void> {
  const isRunning = await isServerRunning(port, host);
  if (isRunning) return;

  const child = spawn(
    process.execPath,
    [__filename, "server", "--port", String(port), "--host", host],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();

  // Wait for server to answer /health
  const start = Date.now();
  while (Date.now() - start < 4000) {
    if (await isServerRunning(port, host)) return;
    await new Promise((r) => setTimeout(r, 100));
  }

  throw new Error(`Failed to start zen-axi daemon on port ${port}`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log("zen-axi v0.1.0");
    return;
  }

  // ---------------------------------------------------------------------------
  // zen-axi server (foreground daemon worker)
  // ---------------------------------------------------------------------------
  if (command === "server") {
    const portIdx = args.indexOf("--port");
    const hostIdx = args.indexOf("--host");
    const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : DEFAULT_PORT;
    const host = hostIdx !== -1 ? args[hostIdx + 1] : DEFAULT_HOST;

    const server = new ZenServer({ port, host });
    await server.start();
    console.log(pc.green(`Zen AXI Server listening on http://${host}:${port}`));
    return;
  }

  // ---------------------------------------------------------------------------
  // zen-axi stop
  // ---------------------------------------------------------------------------
  if (command === "stop") {
    const isRunning = await isServerRunning();
    if (!isRunning) {
      console.log(pc.yellow("Zen AXI server is not running."));
      return;
    }

    const req = http.request(
      `http://${DEFAULT_HOST}:${DEFAULT_PORT}/shutdown`,
      { method: "POST" },
      (res) => {
        if (res.statusCode === 200) {
          console.log(pc.green("✓ Zen AXI server stopped successfully."));
        } else {
          console.log(pc.red("Failed to stop server."));
        }
      },
    );
    req.on("error", (err) => console.error(pc.red(`Error: ${err.message}`)));
    req.end();
    return;
  }

  // ---------------------------------------------------------------------------
  // zen-axi status
  // ---------------------------------------------------------------------------
  if (command === "status") {
    const isRunning = await isServerRunning();
    if (!isRunning) {
      console.log(pc.yellow("Zen AXI server is not running."));
      return;
    }
    const store = new SessionStore();
    const sessions = store.getAllSessions();
    console.log(
      pc.bold(pc.cyan(`\nZen AXI Server: Running on http://${DEFAULT_HOST}:${DEFAULT_PORT}`)),
    );
    console.log(`Active Sessions: ${sessions.length}\n`);
    for (const s of sessions) {
      const statusStr = s.ended ? pc.red("[ENDED]") : pc.green("[ACTIVE]");
      console.log(`  ${statusStr} ${pc.bold(s.filePath)} (${s.docType})`);
      console.log(`    URL: http://${DEFAULT_HOST}:${DEFAULT_PORT}/session/${s.key}`);
      console.log(`    Queued Prompts: ${s.queuedPrompts.length}`);
    }
    console.log("");
    return;
  }

  // ---------------------------------------------------------------------------
  // zen-axi poll <file> [--agent-reply "..."]
  // ---------------------------------------------------------------------------
  if (command === "poll") {
    const file = args[1];
    if (!file) {
      console.error(
        pc.red("Error: Please specify a file to poll. Example: zen-axi poll docs/plans/spec.md"),
      );
      process.exit(1);
    }

    const canonicalPath = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
    const key = sessionKey(canonicalPath);

    // Optional --agent-reply flag
    const replyIdx = args.indexOf("--agent-reply");
    if (replyIdx !== -1 && args[replyIdx + 1]) {
      const replyText = args[replyIdx + 1];
      await sendAgentReply(key, replyText);
    }

    // Long poll HTTP
    process.stderr.write(
      pc.cyan(`\n⏳ Zen AXI: Waiting for human feedback on ${pc.bold(path.basename(file))}...\n`),
    );

    const pollUrl = `http://${DEFAULT_HOST}:${DEFAULT_PORT}/api/poll?key=${key}`;
    const req = http.get(pollUrl, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        const trimmed = body.trim();
        if (!trimmed) return;
        try {
          const data = JSON.parse(trimmed);
          if (data.status === "superseded") {
            process.exit(0);
          }
          console.log(JSON.stringify(data, null, 2));
        } catch {
          console.log(trimmed);
        }
      });
    });

    req.on("error", (err) => {
      console.error(pc.red(`\nPoll error: ${err.message}`));
      process.exit(1);
    });

    return;
  }

  // ---------------------------------------------------------------------------
  // zen-axi reply <file> --message "..."
  // ---------------------------------------------------------------------------
  if (command === "reply") {
    const file = args[1];
    const msgIdx =
      args.indexOf("--message") !== -1 ? args.indexOf("--message") : args.indexOf("-m");
    const message = msgIdx !== -1 ? args[msgIdx + 1] : args[2];

    if (!file || !message) {
      console.error(pc.red("Usage: zen-axi reply <file> --message <text>"));
      process.exit(1);
    }

    const canonicalPath = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
    const key = sessionKey(canonicalPath);
    await sendAgentReply(key, message);
    console.log(pc.green("✓ Reply delivered to browser conversation."));
    return;
  }

  // ---------------------------------------------------------------------------
  // zen-axi end <file>
  // ---------------------------------------------------------------------------
  if (command === "end") {
    const file = args[1];
    if (!file) {
      console.error(pc.red("Error: Please specify a file to end session."));
      process.exit(1);
    }

    const canonicalPath = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
    const key = sessionKey(canonicalPath);

    const postData = JSON.stringify({ endedBy: "agent" });
    const req = http.request(
      `http://${DEFAULT_HOST}:${DEFAULT_PORT}/api/${key}/end`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        if (res.statusCode === 200) {
          console.log(pc.green(`✓ Session for ${pc.bold(file)} concluded as agent.`));
        }
      },
    );
    req.on("error", (err) => console.error(pc.red(`Error: ${err.message}`)));
    req.write(postData);
    req.end();
    return;
  }

  // ---------------------------------------------------------------------------
  // zen-axi export <file> [--out <dest>]
  // ---------------------------------------------------------------------------
  if (command === "export") {
    const file = args[1];
    if (!file || !fs.existsSync(file)) {
      console.error(pc.red(`Error: File not found: ${file}`));
      process.exit(1);
    }

    const raw = fs.readFileSync(file, "utf8");
    const ext = path.extname(file).toLowerCase();
    const renderedBody = ext === ".html" ? raw : renderMarkdownWithSourceLines(raw);

    const outIdx = args.indexOf("--out");
    const outPath = outIdx !== -1 ? args[outIdx + 1] : file.replace(/\.(md|html)$/, ".export.html");

    const standaloneHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${path.basename(file)} - Zen Export</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css">
  <script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; max-width: 860px; margin: 2rem auto; padding: 0 1.5rem; color: #1f2937; }
    pre { background: #f3f4f6; padding: 1rem; border-radius: 6px; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
    th, td { border: 1px solid #e5e7eb; padding: 0.5rem 0.75rem; text-align: left; }
    th { background: #f9fafb; }
    blockquote { border-left: 4px solid #3b82f6; margin: 1rem 0; padding-left: 1rem; color: #4b5563; }
  </style>
</head>
<body>
  ${renderedBody}
  <script>
    mermaid.initialize({ startOnLoad: true, theme: 'neutral' });
  </script>
</body>
</html>`;

    fs.writeFileSync(outPath, standaloneHtml, "utf8");
    console.log(pc.green(`✓ Exported standalone document to: ${pc.bold(outPath)}`));
    return;
  }

  // ---------------------------------------------------------------------------
  // Default: zen-axi <file.md|file.html>
  // ---------------------------------------------------------------------------
  const targetFile = command;
  if (!fs.existsSync(targetFile)) {
    console.error(pc.red(`Error: File does not exist: ${targetFile}`));
    process.exit(1);
  }

  const canonicalPath = fs.realpathSync(targetFile);
  const store = new SessionStore();
  const session = store.getOrCreateSession(canonicalPath);

  // Ensure background daemon is running
  await startServerDaemon();

  const sessionUrl = `http://${DEFAULT_HOST}:${DEFAULT_PORT}/session/${session.key}`;
  const noOpen = args.includes("--no-open");

  if (!noOpen) {
    await open(sessionUrl);
  }

  console.log(pc.bold(pc.cyan("\n🧘 Zen AXI Reviewer\n")));
  console.log(`  ${pc.bold("File:")}     ${pc.green(targetFile)} (${session.docType})`);
  console.log(`  ${pc.bold("Review:")}   ${pc.underline(sessionUrl)}`);
  console.log(`  ${pc.bold("Status:")}   ${session.ended ? pc.red("Ended") : pc.green("Active")}`);
  console.log(
    `\n${pc.dim("Next step:")} Run ${pc.cyan(`zen-axi poll "${targetFile}"`)} to wait for human feedback.\n`,
  );
}

async function sendAgentReply(key: string, message: string): Promise<void> {
  const postData = JSON.stringify({ message });
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://${DEFAULT_HOST}:${DEFAULT_PORT}/api/${key}/reply`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        if (res.statusCode === 200) resolve();
        else reject(new Error(`Status ${res.statusCode}`));
      },
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

function printHelp() {
  console.log(`
${pc.bold(pc.cyan("Zen AXI"))} - Minimalist, token-efficient Agent Experience Interface (AXI) for Markdown & HTML artifacts

${pc.bold("USAGE:")}
  zen-axi <file.md|file.html>          Open or resume review session in browser
  zen-axi poll <file>                  Wait for human feedback via long-polling
  zen-axi reply <file> --message "..." Send progress message to browser conversation
  zen-axi end <file>                   Conclude review session as agent
  zen-axi export <file> [--out <dest>] Export standalone portable HTML
  zen-axi status                       List active review sessions
  zen-axi stop                         Stop local background daemon

${pc.bold("FLAGS:")}
  --no-open                            Start/resume session without launching browser
  --agent-reply "<msg>"                Attach agent reply when polling
  --help, -h                           Show this help message
  --version, -v                        Show version
`);
}

main().catch((err) => {
  console.error(pc.red(`Error: ${err.message}`));
  process.exit(1);
});
