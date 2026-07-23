/**
 * CSV parse + validate for student credential files.
 * Expected format: header row + exactly 2 columns (identifier, password).
 */

export interface CsvRow {
  identifier: string;
  password: string;
}

export type CsvParseResult =
  | { ok: true; rows: CsvRow[] }
  | { ok: false; error: string };

/** Split one CSV line respecting double-quoted fields. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

const HEADER_ID = /^(identifier|username|email|user|login|id)$/i;
const HEADER_PW = /^(password|pass|pwd|secret|credential)$/i;

/**
 * Validate and parse a credential CSV.
 * Requires a header row with two recognized columns and at least one data row.
 */
export function parseCredentialCsv(text: string): CsvParseResult {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return { ok: false, error: "The file is empty. Add a header row and student rows." };
  }

  const header = splitCsvLine(lines[0]!);
  if (header.length !== 2) {
    return {
      ok: false,
      error: "CSV must have exactly 2 columns: identifier and password.",
    };
  }

  const [h0, h1] = header;
  const headerLooksValid =
    (HEADER_ID.test(h0!) && HEADER_PW.test(h1!)) ||
    (HEADER_PW.test(h0!) && HEADER_ID.test(h1!));

  if (!headerLooksValid) {
    return {
      ok: false,
      error:
        "Missing or invalid header row. First line must be: identifier,password",
    };
  }

  const idFirst = HEADER_ID.test(h0!);
  if (lines.length < 2) {
    return {
      ok: false,
      error: "No student rows found under the header. Add at least one row.",
    };
  }

  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]!);
    if (cols.length !== 2) {
      return {
        ok: false,
        error: `Row ${i + 1} must have exactly 2 columns (found ${cols.length}).`,
      };
    }
    const identifier = (idFirst ? cols[0]! : cols[1]!).trim();
    const password = (idFirst ? cols[1]! : cols[0]!).trim();
    if (!identifier) {
      return { ok: false, error: `Row ${i + 1} has an empty identifier.` };
    }
    if (!password) {
      return { ok: false, error: `Row ${i + 1} has an empty password.` };
    }
    rows.push({ identifier, password });
  }

  return { ok: true, rows };
}

/** Build a failure-report CSV for download. */
export function buildFailureCsv(
  failures: Array<{ identifier: string; failure_reason: string }>,
): string {
  const lines = ["identifier,failure_reason"];
  for (const f of failures) {
    lines.push(`${csvEscape(f.identifier)},${csvEscape(f.failure_reason)}`);
  }
  return lines.join("\n") + "\n";
}

function csvEscape(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
