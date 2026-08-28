/** Join class names, dropping anything falsy. Later strings win by order. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
