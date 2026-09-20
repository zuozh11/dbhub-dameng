import { beforeEach, describe, expect, it, vi } from "vitest";
import dmdb from "dmdb";
import { DamengConnector } from "../dameng/index.js";
import { policyFromReadonly, sqlVerdict } from "../../utils/sql-access-policy.js";
import { buildDSNFromSource } from "../../config/toml-loader.js";
import { getDatabaseTypeFromDSN } from "../../utils/dsn-obfuscate.js";
import { validateParameters } from "../../utils/parameter-mapper.js";

vi.mock("dmdb", () => ({ default: { createPool: vi.fn(), OUT_FORMAT_OBJECT: 4002 } }));

const execute = vi.fn();
const close = vi.fn();
const poolClose = vi.fn();
const getConnection = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  execute.mockResolvedValue({ rows: [{ SCHEMA_NAME: "APP" }] });
  close.mockResolvedValue(undefined);
  poolClose.mockResolvedValue(undefined);
  getConnection.mockResolvedValue({ execute, close });
  vi.mocked(dmdb.createPool).mockResolvedValue({ getConnection, close: poolClose } as any);
});

describe("minimal Dameng connector", () => {
  it("accepts DSN and structured configuration without exposing credentials", async () => {
    const connector = new DamengConnector();
    const dsn = buildDSNFromSource({
      id: "dm",
      type: "dameng",
      host: "localhost",
      database: "MixedCase",
      user: "reader",
      password: "p@ss",
    });
    expect(getDatabaseTypeFromDSN(dsn)).toBe("dameng");
    const config = await connector.dsnParser.parse(dsn, {
      connectionTimeoutSeconds: 5,
      queryTimeoutSeconds: 20,
    });
    expect(config.connectString).toContain("reader:p%40ss@localhost:5236");
    expect(config.connectString).toContain("schema=MixedCase");
    expect(config.connectString).toContain("connectTimeout=5000");
    expect(config.connectString).toContain("sessionTimeout=20");
    expect(() =>
      validateParameters(
        "SELECT ? FROM DUAL",
        [{ name: "value", type: "string", description: "Bound value" }],
        "dameng"
      )
    ).not.toThrow();
  });

  it("uses native binds, preserves statement order and reports truncation", async () => {
    const connector = new DamengConnector();
    await connector.connect("dameng://reader:password@localhost/APP");
    execute
      .mockResolvedValueOnce({ rows: [{ N: 1 }, { N: 2 }, { N: 3 }] })
      .mockResolvedValueOnce({ rows: [{ N: 9 }] });
    const result = await connector.executeSQL(
      "WITH x AS (SELECT 1 FROM DUAL) SELECT * FROM x; SELECT 9 FROM DUAL -- tail",
      { maxRows: 2 }
    );
    expect(result.resultSets).toMatchObject([
      { rows: [{ N: 1 }, { N: 2 }], rowCount: 2, truncated: true },
      { rows: [{ N: 9 }], rowCount: 1 },
    ]);
    expect(execute.mock.calls[1][2]).toMatchObject({ maxRows: 3 });
    execute.mockResolvedValueOnce({ rows: [{ VALUE: "?" }] });
    await connector.executeSQL("SELECT ? AS VALUE FROM DUAL", {}, ["?"]);
    expect(execute).toHaveBeenLastCalledWith(
      "SELECT ? AS VALUE FROM DUAL",
      ["?"],
      expect.any(Object)
    );
    await connector.disconnect();
    expect(poolClose).toHaveBeenCalledOnce();
  });

  it("maps catalog data and preserves quoted identifier case", async () => {
    const connector = new DamengConnector();
    await connector.connect("dameng://reader:password@localhost/APP");
    expect(await connector.getDefaultSchema()).toBe("APP");
    execute.mockResolvedValueOnce({
      rows: [
        {
          COLUMN_NAME: "mixedName",
          DATA_TYPE: "VARCHAR",
          NULLABLE: "Y",
          DATA_DEFAULT: null,
          DESCRIPTION: "Label",
        },
      ],
    });
    expect(await connector.getTableSchema("MixedTable", "MixedSchema")).toEqual([
      {
        column_name: "mixedName",
        data_type: "VARCHAR",
        is_nullable: "YES",
        column_default: null,
        description: "Label",
      },
    ]);
    expect(execute.mock.calls.at(-1)?.[1]).toEqual({
      schema: "MixedSchema",
      table_name: "MixedTable",
    });
  });

  it("uses upstream readonly policy for Dameng", () => {
    const policy = policyFromReadonly(true);
    expect(sqlVerdict(policy, "WITH x AS (SELECT 1 FROM DUAL) SELECT * FROM x", "dameng")).toBe(
      "allow"
    );
    expect(sqlVerdict(policy, "SELECT 1 FROM DUAL; DELETE FROM t", "dameng")).toBe("deny");
  });

  it("returns execution errors and releases the connection", async () => {
    const connector = new DamengConnector();
    await connector.connect("dameng://reader:password@localhost/APP");
    execute.mockRejectedValueOnce(new Error("invalid SQL"));
    const callsBefore = getConnection.mock.calls.length;
    await expect(connector.executeSQL("invalid SQL", {})).rejects.toThrow("invalid SQL");
    expect(getConnection.mock.calls.length).toBe(callsBefore + 1);
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe("Dameng Oracle-compatible features", () => {
  async function connected() {
    const connector = new DamengConnector();
    await connector.connect("dameng://reader:password@localhost/APP");
    execute.mockClear();
    return connector;
  }

  it("keeps PL/SQL blocks intact, including alternative quotes and nested control flow", async () => {
    const connector = await connected();
    const block =
      "DECLARE n INT; BEGIN n := 1; IF n = 1 THEN n := 2; END IF; BEGIN n := 3; END; END;";
    await connector.executeSQL(`${block}\n/\nSELECT q'[a;b]' AS VALUE FROM DUAL;`, {});
    expect(execute.mock.calls.map(([sql]) => sql)).toEqual([
      block,
      "SELECT q'[a;b]' AS VALUE FROM DUAL",
    ]);
    expect(execute.mock.calls[0][2]).toMatchObject({ autoCommit: true });
  });

  it("rejects blocks and dangerous package calls before reaching a readonly connection", async () => {
    const connector = await connected();
    for (const sql of [
      "BEGIN DELETE FROM t; END;",
      "SELECT DBMS_SQL.EXECUTE(1) FROM DUAL",
      "SELECT 1 FROM DUAL; DELETE FROM t",
    ]) {
      await expect(connector.executeSQL(sql, { readonly: true })).rejects.toThrow("Read-only");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns a native plan without executing the explained query", async () => {
    const connector = await connected();
    execute.mockResolvedValueOnce({ rows: [{ OPERATION: "NSET2" }] });
    const result = await connector.executeSQL("-- inspect\nEXPLAIN SELECT 1 FROM DUAL;", {
      readonly: true,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith("EXPLAIN FOR SELECT 1 FROM DUAL", [], {
      outFormat: 4002,
    });
    expect(result.resultSets[0].rows).toEqual([{ OPERATION: "NSET2" }]);
  });

  it("rejects bound EXPLAIN parameters without interpolating or submitting them", async () => {
    const connector = await connected();
    await expect(connector.executeSQL("EXPLAIN SELECT ? FROM DUAL", {}, [1])).rejects.toThrow(
      "does not support bound parameters"
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    "EXPLAIN ANALYZE SELECT 1 FROM DUAL",
    "EXPLAIN DELETE FROM t",
    "EXPLAIN FOR DELETE FROM t",
    "EXPLAIN SELECT 1 FROM DUAL; SELECT 2 FROM DUAL",
    "EXPLAIN AS saved_plan FOR SELECT 1 FROM DUAL",
  ])("rejects unsafe or ambiguous plan request: %s", async (sql) => {
    const connector = await connected();
    await expect(connector.executeSQL(sql, {})).rejects.toThrow("EXPLAIN requires");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not report an empty native plan as success", async () => {
    const connector = await connected();
    execute.mockResolvedValueOnce({ rowsAffected: 0 });
    await expect(connector.executeSQL("EXPLAIN SELECT 1 FROM DUAL", {})).rejects.toThrow(
      "no execution plan"
    );
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("reads routine parameters, return type and source through the shared catalog", async () => {
    const connector = await connected();
    execute
      .mockResolvedValueOnce({ rows: [{ OBJECT_TYPE: "FUNCTION" }] })
      .mockResolvedValueOnce({
        rows: [
          { POSITION: 0, ARGUMENT_NAME: null, DATA_TYPE: "INTEGER", IN_OUT: "OUT" },
          { POSITION: 1, ARGUMENT_NAME: "inputValue", DATA_TYPE: "INTEGER", IN_OUT: "IN" },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ TEXT: "FUNCTION f" }, { TEXT: " RETURN INTEGER" }] });
    expect(await connector.getStoredProcedureDetail("f", "MixedSchema")).toMatchObject({
      procedure_name: "f",
      procedure_type: "function",
      language: "plsql",
      parameter_list: "inputValue IN INTEGER",
      return_type: "INTEGER",
      definition: "FUNCTION f RETURN INTEGER",
    });
    expect(execute.mock.calls[0][1]).toEqual({ schema: "MixedSchema", name: "f" });
  });

  it("reports DM session and cache metrics using DM counter semantics", async () => {
    const connector = await connected();
    execute
      .mockResolvedValueOnce({ rows: [{ TOTAL: 6, ACTIVE: 2, IDLE: 4, IDLE_IN_TRANSACTION: 1 }] })
      .mockResolvedValueOnce({ rows: [{ PARA_VALUE: "2000" }] })
      .mockResolvedValueOnce({ rows: [{ HITS: 80, MISSES: 20 }] });
    const result = await connector.getHealthCheck();
    expect(result.connections).toMatchObject({
      total: 6,
      active: 2,
      idle: 4,
      idleInTransaction: 1,
      maxConnections: 2000,
    });
    expect(result.bufferCache).toEqual({ hitRatioPct: 80, blocksHit: 80, blocksRead: 20 });
    expect(result.connections?.longestActiveQuerySeconds).toBeNull();
  });

  it("degrades unavailable health sections without inventing zero-valued metrics", async () => {
    const connector = await connected();
    execute
      .mockRejectedValueOnce(new Error("no permission"))
      .mockResolvedValueOnce({ rows: [{ HITS: 0, MISSES: 0 }] });
    const result = await connector.getHealthCheck();
    expect(result.connections).toBeUndefined();
    expect(result.bufferCache?.hitRatioPct).toBeNull();
    expect(result.notes).toContain("Session metrics unavailable: cannot read V$SESSIONS.");
  });
});
