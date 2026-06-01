export function shellQuoteSingle(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function joinFlags(parts: Array<string | null | undefined>): string {
  return parts.filter((x): x is string => Boolean(x)).join(" ");
}
