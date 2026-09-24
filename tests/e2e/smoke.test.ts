import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const clientDist = fileURLToPath(new URL("../../dist/client/", import.meta.url));

it("builds the client bundle", () => {
  expect(fs.existsSync(`${clientDist}index.html`)).toBe(true);
  expect(fs.existsSync(`${clientDist}main.js`)).toBe(true);
});
