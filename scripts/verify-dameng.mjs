// Read-only smoke test against an explicitly selected local configuration.
// Usage: node scripts/verify-dameng.mjs /absolute/path/to/dbhub.toml [source-id]
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import toml from "@iarna/toml";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

assert(process.argv[2], "Pass a local TOML configuration path explicitly");
const config = toml.parse(readFileSync(process.argv[2], "utf8"));
const source = config.sources.find((s) =>
  process.argv[3] ? s.id === process.argv[3] : s.type === "dameng" || s.dsn?.startsWith("dameng://")
);
assert(source, "No matching Dameng source");
const dir = mkdtempSync(join(tmpdir(), "dbhub-dameng-smoke-"));
const configPath = join(dir, "dbhub.toml");
// Never run a source's init_script in a read-only verification.
const { init_script, ...connection } = source;
writeFileSync(
  configPath,
  toml.stringify({
    sources: [{ ...connection, id: "default" }],
    tools: [
      { name: "execute_sql", source: "default", readonly: true, max_rows: 2 },
      { name: "search_objects", source: "default" },
    ],
  }),
  { mode: 0o600 }
);
const client = new Client({ name: "dameng-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/index.js"), "--transport", "stdio", "--config", configPath],
  cwd: dir,
  env: { ...process.env },
  stderr: "pipe",
});
// Consume diagnostics without printing source configuration or data.
transport.stderr?.on("data", () => {});
async function call(name, args) {
  const response = await client.callTool({ name, arguments: args });
  const payload = JSON.parse(response.content.map((item) => item.text ?? "").join(""));
  assert(!response.isError, `${name}: ${payload.error ?? "failed"}`);
  return payload;
}
try {
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), [
    "execute_sql",
    "search_objects",
  ]);
  console.log("OK: exactly two MCP tools");
  const query = await call("execute_sql", {
    sql: "WITH x AS (SELECT 1 AS N FROM DUAL UNION ALL SELECT 2 FROM DUAL UNION ALL SELECT 3 FROM DUAL) SELECT N FROM x -- tail\n; SELECT 9 AS N FROM DUAL",
  });
  assert.equal(query.data.statements.length, 2);
  assert.equal(query.data.statements[0].rows.length, 2);
  assert.equal(query.data.statements[0].truncated, true);
  assert.equal(query.data.statements[1].rows[0].N, 9);
  console.log("OK: CTE, trailing comment, multiple results, row cap and truncation");
  await call("search_objects", { object_type: "schema", limit: 1, detail_level: "names" });
  const tables = await call("search_objects", {
    object_type: "table",
    limit: 1,
    detail_level: "full",
  });
  assert(tables.data.results.length > 0, "Expected a visible table in the test schema");
  const table = tables.data.results[0];
  assert(!table.error, table.error);
  assert(table.columns.length > 0, "Expected table columns");
  assert(Array.isArray(table.indexes), "Expected table indexes");
  await call("search_objects", { object_type: "view", limit: 1, detail_level: "names" });
  await call("search_objects", { object_type: "procedure", limit: 1, detail_level: "names" });
  console.log("OK: schema/table/column/index/comment/view/procedure discovery");
  // EXPLAIN is unsupported by this minimal connector and denied by readonly policy.
  // Verify the gate without ever submitting a write to a shared database.
  const denied = await client.callTool({
    name: "execute_sql",
    arguments: { sql: "EXPLAIN SELECT 1 FROM DUAL" },
  });
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied), /READONLY_VIOLATION/);
  console.log("OK: upstream readonly gate");
} finally {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
}
