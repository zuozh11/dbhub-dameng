import { beforeEach, describe, expect, it, vi } from "vitest";
import oracledb from "oracledb";
import { OracleConnector } from "../oracle/index.js";

vi.mock("oracledb", () => ({ default: { createPool: vi.fn(), OUT_FORMAT_OBJECT: 4002 } }));
const execute = vi.fn();
const close = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  execute.mockResolvedValue({ rows: [{ SCHEMA_NAME: "APP" }] });
  vi.mocked(oracledb.createPool).mockResolvedValue({
    getConnection: vi.fn().mockResolvedValue({ execute, close }),
    close: vi.fn(),
  } as any);
});

describe("Oracle shared catalog integration", () => {
  it("retains Oracle identifier folding, type formatting and driver fetch options", async () => {
    const db = new OracleConnector();
    await db.connect("oracle://reader:password@localhost/service");
    execute.mockResolvedValueOnce({
      rows: [
        {
          COLUMN_NAME: "ID",
          DATA_TYPE: "NUMBER",
          DATA_PRECISION: 20,
          DATA_SCALE: 0,
          NULLABLE: "N",
          DATA_DEFAULT: " 1 ",
          DESCRIPTION: "Identifier",
        },
      ],
    });
    expect(await db.getTableSchema("orders", "app")).toEqual([
      {
        column_name: "ID",
        data_type: "NUMBER(20)",
        is_nullable: "NO",
        column_default: "1",
        description: "Identifier",
      },
    ]);
    expect(execute.mock.calls.at(-1)?.[1]).toEqual({ schema: "APP", table_name: "ORDERS" });
    expect(execute.mock.calls.at(-1)?.[2]).toMatchObject({
      outFormat: 4002,
      fetchTypeHandler: expect.any(Function),
    });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("groups multi-column indexes and preserves exact mixed-case names", async () => {
    const db = new OracleConnector();
    await db.connect("oracle://reader:password@localhost/service");
    execute.mockResolvedValueOnce({
      rows: [
        { INDEX_NAME: "PK", UNIQUENESS: "UNIQUE", IS_PRIMARY: 1, COLUMN_NAME: "A" },
        { INDEX_NAME: "PK", UNIQUENESS: "UNIQUE", IS_PRIMARY: 1, COLUMN_NAME: "B" },
      ],
    });
    expect(await db.getTableIndexes("MixedTable", "MixedOwner")).toEqual([
      {
        index_name: "PK",
        is_unique: true,
        is_primary: true,
        column_names: ["A", "B"],
      },
    ]);
    expect(execute.mock.calls.at(-1)?.[1]).toEqual({
      schema: "MixedOwner",
      table_name: "MixedTable",
    });
  });
});
