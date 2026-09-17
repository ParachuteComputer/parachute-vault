/** Response-only redaction; never remove stored provenance or rewrite note content.
 * Tag-restricted sessions do not receive historical editor/interface identities.
 * The transport must establish note visibility before applying this projection.
 */
export function projectHistoryProvenance<T extends object>(row: T, restricted: boolean): T | Omit<T, "actor" | "via"> {
  if (!restricted) return row;
  const { actor: _actor, via: _via, ...visible } = row as T & { actor?: unknown; via?: unknown };
  return visible;
}
