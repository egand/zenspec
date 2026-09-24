import { useState } from "preact/hooks";

interface Props {
  lang: string;
  value: string;
  /** Line of the first code line, relative to the block's first line. */
  firstLine: number;
}

/** Fenced code with a language badge and a copy button. Each line is addressable for highlights. */
export function CodeBlock({ lang, value, firstLine }: Props) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div class="zen-code">
      <div class="zen-code-header" data-zen-ui>
        <span class="zen-code-lang">{lang || "text"}</span>
        <button type="button" class="zen-code-copy" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code class={lang ? `language-${lang}` : undefined}>
          {value.split("\n").map((line, i) => (
            <span
              key={i}
              class="zen-code-line"
              data-rl-start={firstLine + i}
              data-rl-end={firstLine + i}
            >
              {line}
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
