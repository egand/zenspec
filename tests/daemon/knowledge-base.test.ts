import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import type { KbLookupResponse } from "../../src/core/api.js";
import { ROUTES } from "../../src/core/api.js";
import { replay } from "../../src/core/reducer.js";
import { startTestDaemon, tempDir, tempRepo, writeFile } from "./helpers.js";

const PLAN = "# Plan\n\nWe store events as JSON and render with Preact.\n";

it("answers explain threads from existing notes and routes the rest to the agent", async () => {
  const kbRoot = tempDir("kb");
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

  const lookup = await t.api.ok<KbLookupResponse>(
    "GET",
    `${ROUTES.kbLookup}?term=javascript%20object%20notation`,
  );
  expect(lookup).toMatchObject({ configured: true, note: { slug: "json", title: "JSON" } });

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
