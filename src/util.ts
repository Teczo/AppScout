/** Dedup key for apps: lowercase, whitespace stripped. */
export function normalizeAppName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '');
}
