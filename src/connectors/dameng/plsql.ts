/**
 * Leading keywords of a statement whose body is PL/SQL. Such a statement
 * ends at the semicolon that closes its outermost BEGIN ... END, not at
 * the first semicolon (see splitPLSQLStatements).
 */
const PLSQL_BODY =
  /^(?:begin|declare|create\s+(?:or\s+replace\s+)?(?:(?:editionable|noneditionable)\s+)?(?:procedure|function|trigger))\b/i;

/**
 * Package specs/bodies and type bodies: `IS ... END name;` with no BEGIN
 * of their own at the top level, so the IS/AS opens the block.
 */
const PLSQL_UNIT =
  /^create\s+(?:or\s+replace\s+)?(?:(?:editionable|noneditionable)\s+)?(?:package(?:\s+body)?|type\s+body)\b/i;

// The blanked SQL retains the offsets of the original SQL.
export function splitPLSQLStatements(sql: string, blanked: string): string[] {
  const statements: string[] = [];
  // Whitespace and SQL*Plus `/` terminator lines between statements.
  const boundary = /(?:\s|\/(?=[ \t]*(?:\r?\n|$)))*/y;
  // Plain SQL ends at a `;` or a `/` line.
  const plainEnd = /;|^[ \t]*\/[ \t]*$/gm;
  // PL/SQL block-depth tokens. `begin`, `case` and `compound trigger` open
  // depth; `end if` / `end loop` close constructs that never opened depth,
  // so they are neutral; every other `end` (bare, `end case`, a compound
  // trigger's `end before statement` & co.) closes one level.
  const token =
    /\b(begin|case|end|compound\s+trigger)\b(?:\s+(if|loop|case))?|;|^[ \t]*\/[ \t]*$/gim;

  const push = (start: number, end: number) => {
    const text = sql.slice(start, end).trim();
    if (text) statements.push(text);
  };

  let i = 0;
  while (i < blanked.length) {
    boundary.lastIndex = i;
    i += boundary.exec(blanked)![0].length;
    if (i >= blanked.length) break;
    const start = i;

    const rest = blanked.slice(i);
    const isUnit = PLSQL_UNIT.test(rest);
    if (!isUnit && !PLSQL_BODY.test(rest)) {
      plainEnd.lastIndex = i;
      const m = plainEnd.exec(blanked);
      const end = m?.index ?? blanked.length;
      push(start, end);
      i = end + (m?.[0] === ";" ? 1 : 0);
      continue;
    }

    // PL/SQL: ends at the `;` closing the outermost block (kept), or at a
    // `/` line or end of input.
    let depth = isUnit ? 1 : 0;
    let opened = isUnit;
    let end = blanked.length;
    token.lastIndex = i;
    let m: RegExpExecArray | null;
    while ((m = token.exec(blanked)) !== null) {
      if (m[0] === ";") {
        if (opened && depth === 0) {
          end = m.index + 1;
          break;
        }
      } else if (m[1] === undefined) {
        end = m.index; // `/` terminator line
        break;
      } else {
        const keyword = m[1].toLowerCase();
        const closes = m[2]?.toLowerCase();
        if (keyword !== "end") {
          depth++;
          opened = true;
        } else if (closes === undefined || closes === "case") {
          depth--;
        }
      }
    }
    push(start, end);
    i = end;
  }
  return statements;
}
