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
import { generateADRDocument, resolveDefaultAdrPath } from "./adr.js";
import { runMcpServer } from "./mcp.js";
import { startTunnel } from "./tunnel.js";
import { SERVER_DEFAULTS, ActorRole, PollStatus, ProgressStatus } from "./types.js";

const DEFAULT_PORT = SERVER_DEFAULTS.PORT;
const DEFAULT_HOST = SERVER_DEFAULTS.HOST;

const __filename = fileURLToPath(import.meta.url);

async function postToDaemon(apiPath: string, payload: any = {}): Promise<number> {
  const postData = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://${DEFAULT_HOST}:${DEFAULT_PORT}${apiPath}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => resolve(res.statusCode || 500),
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

async function isServerRunning(
  port: number = DEFAULT_PORT,
  host: string = DEFAULT_HOST,
): Promise<boolean> {
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

async function startServerDaemon(
  port: number = DEFAULT_PORT,
  host: string = DEFAULT_HOST,
): Promise<void> {
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

  throw new Error(`Failed to start zenspec daemon on port ${port}`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log("zenspec v0.1.0");
    return;
  }

  // ---------------------------------------------------------------------------
  // zenspec mcp (native Model Context Protocol server over stdio)
  // ---------------------------------------------------------------------------
  if (command === "mcp") {
    await runMcpServer();
    return;
  }

  // ---------------------------------------------------------------------------
  // zenspec server (foreground daemon worker)
  // ---------------------------------------------------------------------------
  if (command === "server") {
    const portIdx = args.indexOf("--port");
    const hostIdx = args.indexOf("--host");
    const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : DEFAULT_PORT;
    const host = hostIdx !== -1 ? args[hostIdx + 1] : DEFAULT_HOST;

    const server = new ZenServer({ port, host });
    await server.start();
    console.log(pc.green(`ZenSpec Server listening on http://${host}:${server.port}`));
    return;
  }

  // ---------------------------------------------------------------------------
  // zenspec stop
  // ---------------------------------------------------------------------------
  if (command === "stop") {
    const isRunning = await isServerRunning();
    if (!isRunning) {
      console.log(pc.yellow("ZenSpec server is not running."));
      return;
    }

    const statusCode = await postToDaemon("/shutdown");
    if (statusCode === 200) {
      console.log(pc.green("✓ ZenSpec server stopped successfully."));
    } else {
      console.log(pc.red("Failed to stop server."));
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // zenspec status
  // ---------------------------------------------------------------------------
  if (command === "status") {
    const isRunning = await isServerRunning();
    if (!isRunning) {
      console.log(pc.yellow("ZenSpec server is not running."));
      return;
    }
    const store = new SessionStore();
    const sessions = store.getAllSessions();
    console.log(
      pc.bold(pc.cyan(`\nZenSpec Server: Running on http://${DEFAULT_HOST}:${DEFAULT_PORT}`)),
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
  // zenspec poll <file> [--agent-reply "..."]
  // ---------------------------------------------------------------------------
  if (command === "poll") {
    const file = args[1];
    if (!file) {
      console.error(
        pc.red("Error: Please specify a file to poll. Example: zenspec poll docs/plans/spec.md"),
      );
      process.exit(1);
    }

    const canonicalPath = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
    const key = sessionKey(canonicalPath);

    // Optional --agent-reply flag
    const replyIdx = args.indexOf("--agent-reply");
    if (replyIdx !== -1 && args[replyIdx + 1]) {
      const replyText = args[replyIdx + 1];
      await postToDaemon(`/api/${key}/reply`, { message: replyText });
    }

    process.stderr.write(
      pc.cyan(`\n⏳ ZenSpec: Waiting for human feedback on ${pc.bold(path.basename(file))}...\n`),
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
          if (data.status === PollStatus.Superseded) {
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
  // zenspec approve <file> [--notes "..."]
  // ---------------------------------------------------------------------------
  if (command === "approve") {
    const file = args[1];
    if (!file) {
      console.error(
        pc.red(
          "Error: Please specify a file to approve. Example: zenspec approve docs/plans/spec.md",
        ),
      );
      process.exit(1);
    }

    const notesIdx = args.indexOf("--notes");
    const notes = notesIdx !== -1 ? args[notesIdx + 1] : undefined;

    const canonicalPath = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
    const key = sessionKey(canonicalPath);

    const statusCode = await postToDaemon(`/api/${key}/approve`, { notes });
    if (statusCode === 200) {
      console.log(
        pc.green(`✓ Plan for ${pc.bold(file)} approved! Agent is authorized to proceed.`),
      );
    } else {
      console.error(pc.red(`Failed to approve plan (status code ${statusCode}).`));
      process.exit(1);
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // zenspec reply <file> --message "..."
  // ---------------------------------------------------------------------------
  if (command === "reply") {
    const file = args[1];
    const msgIdx =
      args.indexOf("--message") !== -1 ? args.indexOf("--message") : args.indexOf("-m");
    const message = msgIdx !== -1 ? args[msgIdx + 1] : args[2];

    if (!file || !message) {
      console.error(pc.red("Usage: zenspec reply <file> --message <text>"));
      process.exit(1);
    }

    const canonicalPath = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
    const key = sessionKey(canonicalPath);
    await postToDaemon(`/api/${key}/reply`, { message });
    console.log(pc.green("✓ Reply delivered to browser conversation."));
    return;
  }

  // ---------------------------------------------------------------------------
  // zenspec progress <file> --step "..." [--status running|done|error] [--details "..."]
  // ---------------------------------------------------------------------------
  if (command === "progress") {
    const file = args[1];
    const stepIdx = args.indexOf("--step");
    const step = stepIdx !== -1 ? args[stepIdx + 1] : args[2];
    const statusIdx = args.indexOf("--status");
    const status = statusIdx !== -1 ? args[statusIdx + 1] : ProgressStatus.Running;
    const detailsIdx = args.indexOf("--details");
    const details = detailsIdx !== -1 ? args[detailsIdx + 1] : undefined;

    if (!file || !step) {
      console.error(pc.red("Usage: zenspec progress <file> --step <text> [--status <status>]"));
      process.exit(1);
    }

    const canonicalPath = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
    const key = sessionKey(canonicalPath);

    const statusCode = await postToDaemon(`/api/${key}/progress`, { step, status, details });
    if (statusCode === 200) {
      console.log(pc.green(`✓ Telemetry progress posted: [${status}] ${step}`));
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // zenspec adr <file> [--out <dest>]
  // ---------------------------------------------------------------------------
  if (command === "adr") {
    const file = args[1];
    if (!file || !fs.existsSync(file)) {
      console.error(pc.red(`Error: File not found: ${file}`));
      process.exit(1);
    }

    const canonicalPath = fs.realpathSync(file);
    const store = new SessionStore();
    const session = store.getOrCreateSession(canonicalPath);
    const raw = fs.readFileSync(canonicalPath, "utf8");

    const outIdx = args.indexOf("--out");
    const customOut = outIdx !== -1 ? args[outIdx + 1] : undefined;
    const outPath = resolveDefaultAdrPath(canonicalPath, customOut);

    const adrContent = generateADRDocument({ session, docContent: raw });
    fs.writeFileSync(outPath, adrContent, "utf8");
    console.log(pc.green(`✓ Architecture Decision Record created: ${pc.bold(outPath)}`));
    return;
  }

  // ---------------------------------------------------------------------------
  // zenspec end <file>
  // ---------------------------------------------------------------------------
  if (command === "end") {
    const file = args[1];
    if (!file) {
      console.error(pc.red("Error: Please specify a file to end session."));
      process.exit(1);
    }

    const canonicalPath = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
    const key = sessionKey(canonicalPath);

    const statusCode = await postToDaemon(`/api/${key}/end`, { endedBy: ActorRole.Agent });
    if (statusCode === 200) {
      console.log(pc.green(`✓ Session for ${pc.bold(file)} concluded as agent.`));
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // zenspec export <file> [--out <dest>]
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
  <title>${path.basename(file)} - ZenSpec Export</title>
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
  // Default: zenspec <file.md|file.html|folder>
  // ---------------------------------------------------------------------------
  const targetFile = command;
  if (!fs.existsSync(targetFile)) {
    console.error(pc.red(`Error: Path does not exist: ${targetFile}`));
    process.exit(1);
  }

  const isDir = fs.statSync(targetFile).isDirectory();
  const canonicalPath = isDir ? targetFile : fs.realpathSync(targetFile);

  const portIdx = args.indexOf("--port");
  const customPort = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : DEFAULT_PORT;

  const store = new SessionStore();
  const session = store.getOrCreateSession(canonicalPath);

  await startServerDaemon(customPort);

  const sessionUrl = `http://${DEFAULT_HOST}:${customPort}/session/${session.key}`;
  const noOpen = args.includes("--no-open");
  const shouldShare = args.includes("--share");

  if (!noOpen) {
    await open(sessionUrl);
  }

  console.log(pc.bold(pc.cyan("\n🧘 ZenSpec Reviewer\n")));
  console.log(
    `  ${pc.bold("Target:")}   ${pc.green(targetFile)} (${isDir ? "workspace" : session.docType})`,
  );
  console.log(`  ${pc.bold("Review:")}   ${pc.underline(sessionUrl)}`);
  console.log(`  ${pc.bold("Status:")}   ${session.ended ? pc.red("Ended") : pc.green("Active")}`);

  if (shouldShare) {
    console.log(pc.yellow(`\n  🌐 Initializing secure remote sharing tunnel...`));
    try {
      const tunnel = await startTunnel(customPort, session.token);
      console.log(`  ${pc.bold("Public:")}   ${pc.green(pc.underline(tunnel.url))}`);
      console.log(`  ${pc.dim("(Remote link with session authentication)")}`);
    } catch (err: any) {
      console.log(pc.dim(`  Could not start tunnel: ${err.message}`));
    }
  }

  const shouldPoll = args.includes("--poll") || args.includes("-p");
  if (shouldPoll) {
    const replyIdx = args.indexOf("--agent-reply");
    if (replyIdx !== -1 && args[replyIdx + 1]) {
      const replyText = args[replyIdx + 1];
      await postToDaemon(`/api/${session.key}/reply`, { message: replyText });
    }

    process.stderr.write(
      pc.cyan(
        `\n⏳ ZenSpec: Review session live. Waiting for human feedback or approval on ${pc.bold(
          path.basename(targetFile),
        )}...\n`,
      ),
    );

    const pollUrl = `http://${DEFAULT_HOST}:${customPort}/api/poll?key=${session.key}`;
    const req = http.get(pollUrl, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        const trimmed = body.trim();
        if (!trimmed) return;
        try {
          const data = JSON.parse(trimmed);
          if (data.status === PollStatus.Superseded) {
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

  console.log(`\n${pc.bold(pc.yellow("⚠️  MANDATORY REVIEW GATE:"))}`);
  console.log(
    `  Run ${pc.cyan(`zenspec poll "${targetFile}"`)} to wait for human feedback & approval.`,
  );
  console.log(`  Or use single-command mode: ${pc.cyan(`zenspec "${targetFile}" --poll`)}\n`);
}

function printHelp() {
  console.log(`
${pc.bold(pc.cyan("ZenSpec"))} - Minimalist, token-efficient Agent Experience Interface (AXI) for Markdown & HTML artifacts

${pc.bold("USAGE:")}
  zenspec <file|dir>                   Open or resume review session in browser
  zenspec <file|dir> --poll            Open review session AND immediately wait for feedback
  zenspec poll <file>                  Wait for human feedback via long-polling
  zenspec approve <file> [--notes ".."] Approve plan & authorize agent to proceed
  zenspec reply <file> -m "..."        Send progress message to browser conversation
  zenspec progress <file> --step "..." Stream live execution status to reviewer topbar
  zenspec adr <file> [--out <dest>]    Generate Architecture Decision Record (ADR)
  zenspec end <file>                   Conclude review session as agent
  zenspec export <file> [--out <dest>] Export standalone portable HTML
  zenspec mcp                          Run native Model Context Protocol (MCP) server
  zenspec status                       List active review sessions
  zenspec stop                         Stop local background daemon

${pc.bold("FLAGS:")}
  --poll, -p                           Wait for human feedback immediately after launch
  --share                              Start secure remote tunnel for Codespaces/remote dev
  --no-open                            Start/resume session without launching browser
  --agent-reply "<msg>"                Attach agent reply when polling
  --port <number>                      Specify custom server port (default: 4388)
  --help, -h                           Show this help message
  --version, -v                        Show version
`);
}

main().catch((err) => {
  console.error(pc.red(`Error: ${err.message}`));
  process.exit(1);
});
