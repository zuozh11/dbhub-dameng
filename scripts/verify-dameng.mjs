#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import toml from "@iarna/toml";
import { DamengConnector } from "../src/connectors/dameng/index.ts";
import { buildDSNFromSource } from "../src/config/toml-loader.ts";
import { obfuscateDSNPassword } from "../src/utils/dsn-obfuscate.ts";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") {
      args.config = argv[++i];
    } else if (arg === "--source") {
      args.source = argv[++i];
    } else if (arg === "--dsn") {
      args.dsn = argv[++i];
    }
  }
  return args;
}

function interpolateEnv(value) {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? "");
  }
  if (Array.isArray(value)) {
    return value.map(interpolateEnv);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, interpolateEnv(nested)])
    );
  }
  return value;
}

function loadSource(configPath, sourceId) {
  const absolutePath = path.resolve(configPath);
  const parsed = interpolateEnv(toml.parse(fs.readFileSync(absolutePath, "utf8")));
  const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
  const source = sourceId
    ? sources.find((item) => item.id === sourceId)
    : sources.find(
        (item) =>
          item.type === "dameng" ||
          item.dsn?.startsWith("dameng://") ||
          item.dsn?.startsWith("dm://")
      );

  if (!source) {
    const known = sources.map((item) => item.id).filter(Boolean).join(", ") || "none";
    throw new Error(`No Dameng source found in ${absolutePath}. Known source ids: ${known}`);
  }

  return {
    source,
    dsn: buildDSNFromSource(source),
  };
}

function assertRows(result, label) {
  if (!result.rows || result.rows.length === 0) {
    throw new Error(`${label}: expected at least one row`);
  }
}

async function suppressDamengConnectLog(fn) {
  const originalError = console.error;
  console.error = (...args) => {
    const first = args[0];
    if (typeof first === "string" && first.startsWith("Failed to connect to Dameng database")) {
      return;
    }
    originalError(...args);
  };
  try {
    return await fn();
  } finally {
    console.error = originalError;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = args.config || process.env.DBHUB_DAMENG_CONFIG;
  const dsn = args.dsn || process.env.DAMENG_DSN;

  if (!configPath && !dsn) {
    throw new Error(
      "Set DAMENG_DSN or pass --config /path/to/dbhub.dameng.toml. Optional: --source source_id."
    );
  }

  const loaded = dsn ? { source: { id: "dsn" }, dsn } : loadSource(configPath, args.source);
  const connector = new DamengConnector();

  console.log(`source=${loaded.source.id ?? "dsn"}`);
  console.log(`dsn=${obfuscateDSNPassword(loaded.dsn)}`);

  try {
    await suppressDamengConnectLog(() =>
      connector.connect(loaded.dsn, undefined, {
        queryTimeoutSeconds: Number(process.env.DAMENG_VERIFY_TIMEOUT_SECONDS || 30),
      })
    );
    console.log("connect=ok");

    const simple = await connector.executeSQL("SELECT 1 AS OK FROM DUAL", {});
    assertRows(simple, "simple select");
    console.log(`simple_select=ok rows=${simple.rows.length}`);

    const bound = await connector.executeSQL("SELECT ? AS VALUE FROM DUAL", {}, [123]);
    assertRows(bound, "bound select");
    console.log(`parameter_binding=ok rows=${bound.rows.length}`);

    const multi = await connector.executeSQL(
      "SELECT 1 AS A FROM DUAL; SELECT 2 AS B FROM DUAL",
      {}
    );
    console.log(`multi_statement=ok rows=${multi.rows.length}`);

    const limited = await connector.executeSQL(
      "SELECT 1 AS N FROM DUAL UNION ALL SELECT 2 AS N FROM DUAL",
      { maxRows: 1 }
    );
    if (limited.rows.length > 1) {
      throw new Error(`maxRows returned ${limited.rows.length} rows, expected <= 1`);
    }
    console.log(`max_rows=ok rows=${limited.rows.length}`);

    const schemas = await connector.getSchemas();
    console.log(`schemas=ok count=${schemas.length}`);

    const defaultSchema = await connector.getDefaultSchema();
    console.log(`default_schema=${defaultSchema ? "ok" : "missing"}`);

    const tables = await connector.getTables(defaultSchema || undefined);
    console.log(`tables=ok count=${tables.length}`);

    if (tables.length > 0) {
      const tableName = tables[0];
      const columns = await connector.getTableSchema(tableName, defaultSchema || undefined);
      const indexes = await connector.getTableIndexes(tableName, defaultSchema || undefined);
      const count = await connector.getTableRowCount(tableName, defaultSchema || undefined);
      await connector.getTableComment(tableName, defaultSchema || undefined);
      console.log(`table_schema=ok columns=${columns.length}`);
      console.log(`table_indexes=ok count=${indexes.length}`);
      console.log(`table_row_count=ok value=${count === null ? "null" : "number"}`);
      console.log("table_comment=ok");
    } else {
      console.log("table_metadata=skipped no_tables_in_default_schema");
    }

    console.log("dameng_verification=ok");
  } finally {
    await connector.disconnect();
  }
}

main().catch((error) => {
  console.error(`dameng_verification=failed ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
