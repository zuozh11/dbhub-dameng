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
          COMMENTS: "Label",
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
    expect(execute.mock.calls.at(-1)?.[1]).toEqual(["MixedSchema", "MixedTable"]);
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
