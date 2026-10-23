// Minimal CSV parser: comma-separated, double-quoted fields with "" escapes, CRLF or LF.
// First row is the header. Blank lines are skipped.

export interface CsvTable {
  columns: string[];
  rows: Record<string, string>[];
}

export function parseCsv(text: string): CsvTable {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      if (record.some((f) => f.trim() !== "")) records.push(record);
      record = [];
    } else field += ch;
  }
  record.push(field);
  if (record.some((f) => f.trim() !== "")) records.push(record);

  if (records.length === 0) return { columns: [], rows: [] };
  const columns = records[0].map((c) => c.trim());
  const rows = records.slice(1).map((r) => Object.fromEntries(columns.map((c, i) => [c, (r[i] ?? "").trim()])));
  return { columns, rows };
}

/** Replace {column} placeholders; unknown placeholders are left as-is so they are visible. */
export function fillTemplate(template: string, row: Record<string, string>): string {
  return template.replace(/\{([^{}]+)\}/g, (match, key: string) => {
    const k = key.trim();
    return k in row ? row[k] : match;
  });
}

export function placeholdersIn(template: string): string[] {
  return Array.from(new Set(Array.from(template.matchAll(/\{([^{}]+)\}/g), (m) => m[1].trim())));
}
