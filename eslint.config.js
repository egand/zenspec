import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // core is pure: no I/O and no dependency on the layers built on top of it (plan §16).
    files: ["src/core/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["node:*"], message: "core must not do I/O." },
            {
              group: [
                "**/daemon",
                "**/daemon/**",
                "**/cli",
                "**/cli/**",
                "**/client",
                "**/client/**",
              ],
              message: "core must not import from daemon, cli, or client.",
            },
          ],
          paths: [
            "fs",
            "fs/promises",
            "path",
            "http",
            "https",
            "net",
            "os",
            "child_process",
            "chokidar",
            "open",
          ].map((name) => ({ name, message: "core must not do I/O." })),
        },
      ],
    },
  },
);
