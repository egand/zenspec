/** Loads `<home>/config.yaml` (plan §5, §11.1). A missing or invalid file yields `{}`. */
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { ZenspecConfig } from "../core/config.js";
import { expandHome } from "./home.js";

export function loadConfig(home: string): ZenspecConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(home, "config.yaml"), "utf8");
  } catch {
    return {};
  }
  let config: ZenspecConfig;
  try {
    config = (parse(raw) as ZenspecConfig | null) ?? {};
  } catch (err) {
    console.error(`zenspec: ignoring invalid config.yaml: ${(err as Error).message}`);
    return {};
  }
  const kb = config.knowledgeBase;
  if (kb && (typeof kb.root !== "string" || typeof kb.notesDir !== "string")) {
    console.error("zenspec: knowledgeBase needs `root` and `notesDir`; ignoring it");
    delete config.knowledgeBase;
  } else if (kb) {
    config.knowledgeBase = { ...kb, root: expandHome(kb.root) };
  }
  return config;
}
