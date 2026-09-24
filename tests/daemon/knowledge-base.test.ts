import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { KbTermsResponse } from "../../src/core/api.js";
import type { ReviewPayload } from "../../src/core/payload.js";
import { ROUTES } from "../../src/core/api.js";
import { replay } from "../../src/core/reducer.js";
import { startTestDaemon, tempDir, tempRepo, writeFile } from "./helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const PLAN = "# Plan\n\nWe store events as JSON and render with Preact.\n";

it("answers explain threads from existing notes and routes the rest to the agent", async () => {
  const kbRoot = tempDir("kb");
  // Notes under the user's home must still be given as absolute paths, never `~/...`.
  vi.stubEnv("HOME", path.dirname(kbRoot));
  writeFile(
    kbRoot,
    "content/02_concepts/json.md",
    "---\ntitle: JSON\naliases: [JavaScript Object Notation]\nsummary: Text data format.\n---\n",
  );
  const home = tempDir("home");
  fs.writeFileSync(
    path.join(home, "config.yaml"),
    [
      "knowledgeBase:",
      `  root: ${kbRoot}`,
      "  notesDir: content/02_concepts",
      "  template: content/05_templates/concept.md",
      "  link: https://kb.test/{slug}",
    ].join("\n"),
  );
  const root = tempRepo({ "plan.md": PLAN });
  const t = await startTestDaemon({ home });

  const terms = await t.api.ok<KbTermsResponse>("GET", ROUTES.kbTerms);
  expect(terms.notes).toMatchObject([{ slug: "json", title: "JSON" }]);

  const doc = await t.open(`${root}/plan.md`);
  await doc.publish();
  const explain = (term: string) => ({
    kind: "explain" as const,
    term,
    anchor: doc.anchor(PLAN, term, 1),
    body: "What is this?",
    attachments: [],
  });
  await doc.submit({ revision: 1, opened: [explain("JSON"), explain("Preact")] });

  const { events } = await doc.state();
  expect(events.at(-1)).toMatchObject({
    type: "agent_responded",
    author: "daemon",
    responses: [{ thread: "t1", action: "answered", note: "JSON: https://kb.test/json" }],
  });
  expect(replay(events).threads.t1?.status).toBe("addressed");

  const reply = await doc.wait(0);
  expect(reply.status === "delivered" && reply.payload.threads).toEqual([
    {
      id: "t2",
      kind: "explain",
      term: "Preact",
      at: "L3",
      body: "What is this?",
      save_to: path.join(kbRoot, "content/02_concepts/preact.md"),
      template: path.join(kbRoot, "content/05_templates/concept.md"),
    },
  ]);
});

it("gives every path in a payload as an absolute path", async () => {
  const kbRoot = tempDir("kb");
  vi.stubEnv("HOME", path.dirname(kbRoot));
  const home = tempDir("home");
  fs.writeFileSync(
    path.join(home, "config.yaml"),
    `knowledgeBase:\n  root: ${kbRoot}\n  notesDir: notes\n  template: template.md\n`,
  );
  const root = tempRepo({ "plan.md": PLAN });
  const t = await startTestDaemon({ home });
  const doc = await t.open(`${root}/plan.md`);
  await doc.publish();
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000020000000308020000000000000000",
    "hex",
  );
  const image = await fetch(t.api.base + doc.route(ROUTES.attachments), {
    method: "POST",
    body: new Uint8Array(png),
  }).then((r) => r.json());
  await doc.submit({
    revision: 1,
    opened: [
      {
        kind: "explain",
        term: "Preact",
        anchor: doc.anchor(PLAN, "Preact", 1),
        body: "?",
        attachments: [image],
      },
    ],
  });

  const reply = await doc.wait(0);
  const paths = pathFields(reply.status === "delivered" ? reply.payload : null);
  expect(paths).toHaveLength(3);
  for (const p of paths) expect(path.isAbsolute(p), p).toBe(true);
});

/** Every `path`, `save_to` and `template` value in a payload. */
function pathFields(payload: ReviewPayload | null): string[] {
  return (payload?.threads ?? []).flatMap((t) => [
    ...(t.images ?? []).map((i) => i.path),
    ...("save_to" in t && t.save_to ? [t.save_to] : []),
    ...("template" in t && t.template ? [t.template] : []),
  ]);
}
