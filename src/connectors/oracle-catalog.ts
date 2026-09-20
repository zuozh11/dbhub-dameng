import type { TableColumn, TableIndex, StoredProcedure } from "./interface.js";

/** Shared ALL_* catalog queries; drivers and identifier rules stay in each connector. */
export abstract class OracleCatalog {
  protected abstract query<T>(sql: string, binds?: Record<string, string>): Promise<T[]>;
  protected abstract schemaOrDefault(schema?: string): string;

  protected catalogIdentifier(name: string): string {
    return name;
  }

  async getViews(schema?: string): Promise<string[]> {
    try {
      const rows = await this.query<{ VIEW_NAME: string }>(
        `SELECT VIEW_NAME FROM ALL_VIEWS WHERE OWNER = :schema ORDER BY VIEW_NAME`,
        { schema: this.schemaOrDefault(schema) }
      );
      return rows.map((row) => row.VIEW_NAME);
    } catch (error) {
      throw new Error(`Failed to get views: ${(error as Error).message}`);
    }
  }

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    try {
      const rows = await this.query<{
        COLUMN_NAME: string;
        DATA_TYPE: string;
        DATA_LENGTH: number | null;
        CHAR_LENGTH: number | null;
        DATA_PRECISION: number | null;
        DATA_SCALE: number | null;
        NULLABLE: string;
        DATA_DEFAULT: string | null;
        DESCRIPTION: string | null;
      }>(
        `SELECT C.COLUMN_NAME,
                C.DATA_TYPE,
                C.DATA_LENGTH,
                C.CHAR_LENGTH,
                C.DATA_PRECISION,
                C.DATA_SCALE,
                C.NULLABLE,
                C.DATA_DEFAULT,
                CC.COMMENTS AS DESCRIPTION
         FROM ALL_TAB_COLUMNS C
         LEFT JOIN ALL_COL_COMMENTS CC
           ON CC.OWNER = C.OWNER
          AND CC.TABLE_NAME = C.TABLE_NAME
          AND CC.COLUMN_NAME = C.COLUMN_NAME
         WHERE C.OWNER = :schema
           AND C.TABLE_NAME = :table_name
         ORDER BY C.COLUMN_ID`,
        { schema: this.schemaOrDefault(schema), table_name: this.catalogIdentifier(tableName) }
      );

      return rows.map((row) => ({
        column_name: row.COLUMN_NAME,
        data_type: OracleCatalog.formatDataType(row),
        is_nullable: row.NULLABLE === "Y" ? "YES" : "NO",
        // DATA_DEFAULT is a LONG that keeps the DDL's trailing whitespace.
        column_default: row.DATA_DEFAULT?.trim() || null,
        description: row.DESCRIPTION || null,
      }));
    } catch (error) {
      throw new Error(`Failed to get schema for table ${tableName}: ${(error as Error).message}`);
    }
  }

  /**
   * Render a column's type the way it appears in DDL: `VARCHAR2(100)`,
   * `NUMBER(10,2)`, `NUMBER`, `TIMESTAMP(6)`. Oracle's catalog splits these
   * across several columns.
   */
  private static formatDataType(row: {
    DATA_TYPE: string;
    DATA_LENGTH: number | null;
    CHAR_LENGTH: number | null;
    DATA_PRECISION: number | null;
    DATA_SCALE: number | null;
  }): string {
    const type = row.DATA_TYPE;
    if (/^(?:N?VARCHAR2|N?CHAR|RAW)$/.test(type)) {
      const length = type === "RAW" ? row.DATA_LENGTH : row.CHAR_LENGTH;
      return length ? `${type}(${length})` : type;
    }
    if (type === "NUMBER") {
      if (row.DATA_PRECISION === null) {
        // NUMBER(*, s) (INTEGER is NUMBER(*, 0)) has no precision but a scale.
        return row.DATA_SCALE === null ? type : `NUMBER(*,${row.DATA_SCALE})`;
      }
      return row.DATA_SCALE
        ? `NUMBER(${row.DATA_PRECISION},${row.DATA_SCALE})`
        : `NUMBER(${row.DATA_PRECISION})`;
    }
    if (type === "FLOAT" && row.DATA_PRECISION !== null) {
      return `FLOAT(${row.DATA_PRECISION})`;
    }
    // TIMESTAMP(6), TIMESTAMP(6) WITH TIME ZONE, INTERVAL DAY(2) TO SECOND(6)
    // already carry their precision in DATA_TYPE.
    return type;
  }

  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    try {
      const rows = await this.query<{
        INDEX_NAME: string;
        UNIQUENESS: string;
        IS_PRIMARY: number;
        COLUMN_NAME: string;
      }>(
        `SELECT I.INDEX_NAME,
                I.UNIQUENESS,
                CASE WHEN PK.CONSTRAINT_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PRIMARY,
                IC.COLUMN_NAME
         FROM ALL_INDEXES I
         JOIN ALL_IND_COLUMNS IC
           ON IC.INDEX_OWNER = I.OWNER
          AND IC.INDEX_NAME = I.INDEX_NAME
         LEFT JOIN ALL_CONSTRAINTS PK
           ON PK.OWNER = I.TABLE_OWNER
          AND PK.TABLE_NAME = I.TABLE_NAME
          AND PK.CONSTRAINT_TYPE = 'P'
          AND PK.INDEX_OWNER = I.OWNER
          AND PK.INDEX_NAME = I.INDEX_NAME
         WHERE I.TABLE_OWNER = :schema
           AND I.TABLE_NAME = :table_name
         ORDER BY I.INDEX_NAME, IC.COLUMN_POSITION`,
        { schema: this.schemaOrDefault(schema), table_name: this.catalogIdentifier(tableName) }
      );

      const indexMap = new Map<string, TableIndex>();
      for (const row of rows) {
        let index = indexMap.get(row.INDEX_NAME);
        if (!index) {
          index = {
            index_name: row.INDEX_NAME,
            column_names: [],
            is_unique: row.UNIQUENESS === "UNIQUE",
            is_primary: Number(row.IS_PRIMARY) === 1,
          };
          indexMap.set(row.INDEX_NAME, index);
        }
        index.column_names.push(row.COLUMN_NAME);
      }
      return Array.from(indexMap.values());
    } catch (error) {
      throw new Error(`Failed to get indexes for table ${tableName}: ${(error as Error).message}`);
    }
  }

  async getTableComment(tableName: string, schema?: string): Promise<string | null> {
    try {
      const rows = await this.query<{ COMMENTS: string | null }>(
        `SELECT COMMENTS FROM ALL_TAB_COMMENTS WHERE OWNER = :schema AND TABLE_NAME = :table_name`,
        { schema: this.schemaOrDefault(schema), table_name: this.catalogIdentifier(tableName) }
      );
      return rows[0]?.COMMENTS || null;
    } catch {
      return null;
    }
  }

  async getTableRowCount(tableName: string, schema?: string): Promise<number | null> {
    try {
      // Optimizer statistics; NULL until the table has been analyzed, which
      // search_objects reports as an unknown count rather than a stale one.
      const rows = await this.query<{ NUM_ROWS: number | null }>(
        `SELECT NUM_ROWS FROM ALL_TABLES WHERE OWNER = :schema AND TABLE_NAME = :table_name`,
        { schema: this.schemaOrDefault(schema), table_name: this.catalogIdentifier(tableName) }
      );
      const numRows = rows[0]?.NUM_ROWS;
      return numRows === null || numRows === undefined ? null : Number(numRows);
    } catch {
      return null;
    }
  }

  async getStoredProcedures(
    schema?: string,
    routineType?: "procedure" | "function"
  ): Promise<string[]> {
    try {
      const typeFilter =
        routineType === "function"
          ? "object_type = 'FUNCTION'"
          : routineType === "procedure"
            ? "object_type = 'PROCEDURE'"
            : "object_type IN ('PROCEDURE', 'FUNCTION')";
      const rows = await this.query<{ OBJECT_NAME: string }>(
        `SELECT OBJECT_NAME FROM ALL_OBJECTS WHERE OWNER = :schema AND ${typeFilter} ORDER BY OBJECT_NAME`,
        { schema: this.schemaOrDefault(schema) }
      );
      return rows.map((row) => row.OBJECT_NAME);
    } catch (error) {
      throw new Error(`Failed to get stored procedures: ${(error as Error).message}`);
    }
  }

  async getStoredProcedureDetail(procedureName: string, schema?: string): Promise<StoredProcedure> {
    try {
      const schemaToUse = this.schemaOrDefault(schema);
      const name = this.catalogIdentifier(procedureName);

      const objects = await this.query<{ OBJECT_TYPE: string }>(
        `SELECT OBJECT_TYPE
           FROM ALL_OBJECTS
           WHERE OWNER = :schema AND OBJECT_NAME = :name
             AND OBJECT_TYPE IN ('PROCEDURE', 'FUNCTION')`,
        { schema: schemaToUse, name }
      );
      if (objects.length === 0) {
        throw new Error(`Stored procedure '${procedureName}' not found in schema '${schemaToUse}'`);
      }
      const objectType = objects[0].OBJECT_TYPE;
      const isFunction = objectType === "FUNCTION";

      const [args, source] = await Promise.all([
        // Standalone routines only (package_name IS NULL). Position 0 with
        // no argument name is a function's return value.
        this.query<{
          ARGUMENT_NAME: string | null;
          POSITION: number;
          IN_OUT: string;
          DATA_TYPE: string | null;
        }>(
          `SELECT ARGUMENT_NAME, POSITION, IN_OUT, DATA_TYPE
             FROM ALL_ARGUMENTS
             WHERE OWNER = :schema AND OBJECT_NAME = :name
               AND PACKAGE_NAME IS NULL AND DATA_LEVEL = 0
             ORDER BY POSITION`,
          { schema: schemaToUse, name }
        ),
        this.query<{ TEXT: string }>(
          `SELECT TEXT FROM ALL_SOURCE
             WHERE OWNER = :schema AND NAME = :name AND TYPE = :object_type
             ORDER BY LINE`,
          { schema: schemaToUse, name, object_type: objectType }
        ),
      ]);

      const returnType = args.find(
        (arg) => arg.POSITION === 0 && arg.ARGUMENT_NAME === null
      )?.DATA_TYPE;
      const parameterList = args
        .filter((arg) => arg.ARGUMENT_NAME !== null)
        .map((arg) => `${arg.ARGUMENT_NAME} ${arg.IN_OUT} ${arg.DATA_TYPE ?? ""}`.trim())
        .join(", ");

      return {
        procedure_name: name,
        procedure_type: isFunction ? "function" : "procedure",
        language: "plsql",
        parameter_list: parameterList,
        return_type: isFunction ? (returnType ?? undefined) : undefined,
        definition: source.length > 0 ? source.map((row) => row.TEXT).join("") : undefined,
      };
    } catch (error) {
      throw new Error(`Failed to get stored procedure details: ${(error as Error).message}`);
    }
  }
}
