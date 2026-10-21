/**
 * A document marks a domain term in an inline code span with a prefix, so that a reader sees the
 * kind of each noun by its color: `db:Table.column` is a Postgres table or column (the table is the
 * namespace), `fn:name` is a code method, and `obj:Type.field` is a data object. Other markdown
 * renderers show the prefix as plain code, so the mark stays readable there.
 */
export const TERM_KINDS = {
  db: "Postgres table or column",
  fn: "Code method",
  obj: "Data object",
} as const;

export type TermKind = keyof typeof TERM_KINDS;

const TERM = /^(db|fn|obj):(\S.*)$/;

export function domainTerm(code: string): { kind: TermKind; name: string } | null {
  const m = code.match(TERM);
  return m ? { kind: m[1] as TermKind, name: m[2] } : null;
}
