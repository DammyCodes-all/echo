import { DatabaseSync } from "node:sqlite";

export interface FtsIndex {
  /** Number of expanded query terms matching document i (stemmed, prefix). */
  overlap(doc: number, terms: string[]): number;
  close(): void;
}

function escapeTerm(term: string): string {
  return term.replace(/"/g, "");
}

/**
 * Ephemeral per-bundle FTS5 index (porter stemmer). The bundle is small
 * enough that rebuild-per-call costs nothing measurable, and ephemeral
 * means no migration, no ingest changes, no stale index — the persistent
 * table lands later with the server wiring without changing this contract.
 */
export function openFts(documents: string[]): FtsIndex {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(text, tokenize='porter unicode61');");
  const insert = db.prepare("INSERT INTO docs (text) VALUES (?)");
  for (const text of documents) insert.run(text);
  const match = db.prepare("SELECT rowid FROM docs WHERE docs MATCH ?");

  return {
    overlap(doc: number, terms: string[]): number {
      let count = 0;
      for (const term of terms) {
        if (term.length === 0) continue;
        const rows = match.all(`"${escapeTerm(term)}"*`) as Array<{ rowid: number | bigint }>;
        // FTS rowids are 1-based; doc indexes are 0-based.
        if (rows.some((row) => Number(row.rowid) === doc + 1)) count += 1;
      }
      return count;
    },
    close(): void {
      db.close();
    },
  };
}

/** Same expansion the word-overlap scorer used: full token plus its parts. */
export function expandTerms(tokens: Set<string>): string[] {
  const terms = new Set<string>();
  for (const token of tokens) {
    terms.add(token);
    for (const part of token.split(/[./-]+/)) {
      if (part.length >= 3) terms.add(part);
    }
  }
  return [...terms];
}
