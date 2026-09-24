import { expect, it } from "vitest";

it("injects the package version", () => {
  expect(__ZENSPEC_VERSION__).toMatch(/^\d+\.\d+\.\d+/);
});
