// Mention tokens look like `@[Jane Doe](mention:<employee uuid>)`. The label is display text
// only; the id identifies the person. See "Mentions" in .claude/specs/05-comments.md

export const MAX_MENTIONS = 20;

const MENTION_RE = /@\[[^\]\n]{1,150}\]\(mention:([0-9a-fA-F-]{36})\)/g;

// Distinct mentioned ids, lowercased, in first-appearance order. Pure, no DB.
// Tokens inside Markdown code blocks still count (fence detection is out of scope).
export function parseMentionIds(body: string): string[] {
  const ids = new Set<string>();
  for (const match of body.matchAll(MENTION_RE)) ids.add(match[1].toLowerCase());
  return [...ids];
}
