/** Obsidian accepts both scalar tag text and YAML tag arrays. */
export function metadataTags(value: unknown): string[] {
  const values = typeof value === 'string' ? value.split(/[\s,]+/) : Array.isArray(value) ? value : [];
  return values.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.replace(/^#/, '')).filter(Boolean);
}
