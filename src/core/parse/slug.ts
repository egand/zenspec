/** GitHub-style slug: lowercase, punctuation dropped, whitespace runs become `-`. */
export function slugify(text: string, fallback: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
  return slug || fallback;
}

/** Hands out unique slugs, suffixing repeats `-1`, `-2`, ... like GitHub heading anchors. */
export class Slugger {
  private readonly seen = new Set<string>();

  constructor(reserved: string[] = []) {
    for (const slug of reserved) this.seen.add(slug);
  }

  unique(base: string): string {
    let slug = base;
    for (let i = 1; this.seen.has(slug); i++) slug = `${base}-${i}`;
    this.seen.add(slug);
    return slug;
  }
}
