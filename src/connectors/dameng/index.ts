import { randomUUID } from "node:crypto";
import dmdb from "dmdb";
import {
  Connector,
  ConnectorConfig,
  ConnectorRegistry,
  ConnectorType,
  DSNParser,
  ExecuteOptions,
  SQLResult,
  SQLResultSet,
  StoredProcedure,
  TableColumn,
  TableIndex,
} from "../interface.js";
import { SafeURL } from "../../utils/safe-url.js";
import { closeQuietly } from "../../utils/resource-cleanup.js";
import { splitSQLStatements } from "../../utils/sql-parser.js";
import { SQLRowLimiter } from "../../utils/sql-row-limiter.js";

type CatalogRow = Record<string, any>;

class DamengDSNParser implements DSNParser {
  isValidDSN(dsn: string): boolean {
    return dsn.startsWith("dameng://");
  }

  getSampleDSN(): string {
    return "dameng://user:password@localhost:5236/APP";
  }

  async parse(dsn: string, config?: ConnectorConfig): Promise<dmdb.PoolAttributes> {
    if (!this.isValidDSN(dsn)) throw new Error("Expected a dameng:// DSN");
    const url = new SafeURL(dsn);
    if (!url.hostname || !url.username) throw new Error("Dameng DSN requires host and user");
    const params = new URLSearchParams();
    url.forEachSearchParam((value, key) => params.set(key, value));
    if (url.pathname.length > 1) params.set("schema", decodeURIComponent(url.pathname.slice(1)));
    if (config?.connectionTimeoutSeconds !== undefined) {
      params.set("connectTimeout", String(config.connectionTimeoutSeconds * 1000));
    }
    if (config?.queryTimeoutSeconds !== undefined) {
      params.set("sessionTimeout", String(config.queryTimeoutSeconds));
    }
    return {
      connectString:
        `dm://${encodeURIComponent(url.username)}:${encodeURIComponent(url.password)}` +
        `@${url.hostname}:${url.port || 5236}?${params}`,
    };
  }
}

export class DamengConnector implements Connector {
  id: ConnectorType = "dameng";
  name = "Dameng";
  dsnParser = new DamengDSNParser();
  private sourceId = "default";
  private pool: dmdb.Pool | null = null;
  private defaultSchema: string | null = null;

  getId(): string {
    return this.sourceId;
  }
  clone(): Connector {
    return new DamengConnector();
  }

  async connect(dsn: string, initScript?: string, config?: ConnectorConfig): Promise<void> {
    const attributes = await this.dsnParser.parse(dsn, config);
    // Each connector owns its pool; no global/default pool alias is shared.
    this.pool = await dmdb.createPool({ ...attributes, poolAlias: randomUUID() });
    try {
      await this.withConnection(async (conn) => {
        const result = await conn.execute<CatalogRow>(
          "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS SCHEMA_NAME FROM DUAL",
          [],
          { outFormat: dmdb.OUT_FORMAT_OBJECT }
        );
        this.defaultSchema = result.rows![0].SCHEMA_NAME;
        if (initScript) {
          for (const sql of splitSQLStatements(initScript, "dameng")) {
            await conn.execute(sql, [], { autoCommit: true });
          }
        }
      });
    } catch (error) {
      await closeQuietly(() => this.disconnect());
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    this.defaultSchema = null;
    if (pool) await pool.close(0);
  }

  async getDefaultSchema(): Promise<string | null> {
    return this.defaultSchema;
  }

  private async withConnection<T>(run: (conn: dmdb.Connection) => Promise<T>): Promise<T> {
    if (!this.pool) throw new Error("Not connected to Dameng");
    const conn = await this.pool.getConnection();
    try {
      return await run(conn);
    } finally {
      await conn.close();
    }
  }

  private async query(sql: string, parameters: unknown[] = []): Promise<CatalogRow[]> {
    return this.withConnection(async (conn) => {
      const result = await conn.execute<CatalogRow>(sql, parameters, {
        outFormat: dmdb.OUT_FORMAT_OBJECT,
      });
      return result.rows ?? [];
    });
  }

  private owner(schema?: string): string {
    const owner = schema ?? this.defaultSchema;
    if (!owner) throw new Error("No Dameng schema selected");
    return owner;
  }

  async getSchemas(): Promise<string[]> {
    const rows = await this.query("SELECT USERNAME FROM ALL_USERS ORDER BY USERNAME");
    return rows.map((row) => row.USERNAME);
  }

  async getTables(schema?: string): Promise<string[]> {
    const rows = await this.query(
      "SELECT TABLE_NAME FROM ALL_TABLES WHERE OWNER = ? ORDER BY TABLE_NAME",
      [this.owner(schema)]
    );
    return rows.map((row) => row.TABLE_NAME);
  }

  async getViews(schema?: string): Promise<string[]> {
    const rows = await this.query(
      "SELECT VIEW_NAME FROM ALL_VIEWS WHERE OWNER = ? ORDER BY VIEW_NAME",
      [this.owner(schema)]
    );
    return rows.map((row) => row.VIEW_NAME);
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    const rows = await this.query(
      `SELECT COUNT(*) AS CNT FROM ALL_OBJECTS
       WHERE OWNER = ? AND OBJECT_NAME = ? AND OBJECT_TYPE IN ('TABLE', 'VIEW')`,
      [this.owner(schema), tableName]
    );
    return Number(rows[0].CNT) > 0;
  }

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    const rows = await this.query(
      `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.NULLABLE, c.DATA_DEFAULT, cc.COMMENTS
       FROM ALL_TAB_COLUMNS c LEFT JOIN ALL_COL_COMMENTS cc
         ON cc.OWNER = c.OWNER AND cc.TABLE_NAME = c.TABLE_NAME AND cc.COLUMN_NAME = c.COLUMN_NAME
       WHERE c.OWNER = ? AND c.TABLE_NAME = ? ORDER BY c.COLUMN_ID`,
      [this.owner(schema), tableName]
    );
    return rows.map((row) => ({
      column_name: row.COLUMN_NAME,
      data_type: row.DATA_TYPE,
      is_nullable: row.NULLABLE === "Y" ? "YES" : "NO",
      column_default: row.DATA_DEFAULT ?? null,
      description: row.COMMENTS ?? null,
    }));
  }

  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    const rows = await this.query(
      `SELECT i.INDEX_NAME, i.UNIQUENESS, ic.COLUMN_NAME,
              CASE WHEN c.CONSTRAINT_TYPE = 'P' THEN 1 ELSE 0 END AS IS_PRIMARY
       FROM ALL_INDEXES i JOIN ALL_IND_COLUMNS ic
         ON i.OWNER = ic.INDEX_OWNER AND i.INDEX_NAME = ic.INDEX_NAME
       LEFT JOIN ALL_CONSTRAINTS c
         ON c.OWNER = i.TABLE_OWNER AND c.TABLE_NAME = i.TABLE_NAME
        AND c.INDEX_NAME = i.INDEX_NAME AND c.CONSTRAINT_TYPE = 'P'
       WHERE i.TABLE_OWNER = ? AND i.TABLE_NAME = ? ORDER BY i.INDEX_NAME, ic.COLUMN_POSITION`,
      [this.owner(schema), tableName]
    );
    const indexes = new Map<string, TableIndex>();
    for (const row of rows) {
      let index = indexes.get(row.INDEX_NAME);
      if (!index) {
        index = {
          index_name: row.INDEX_NAME,
          column_names: [],
          is_unique: row.UNIQUENESS === "UNIQUE",
          is_primary: Number(row.IS_PRIMARY) === 1,
        };
        indexes.set(row.INDEX_NAME, index);
      }
      index.column_names.push(row.COLUMN_NAME);
    }
    return [...indexes.values()];
  }

  async getStoredProcedures(
    schema?: string,
    routineType?: "procedure" | "function"
  ): Promise<string[]> {
    const rows = await this.query(
      `SELECT OBJECT_NAME FROM ALL_OBJECTS WHERE OWNER = ?
       AND OBJECT_TYPE IN ('PROCEDURE', 'FUNCTION') ${routineType ? "AND OBJECT_TYPE = ?" : ""}
       ORDER BY OBJECT_NAME`,
      routineType ? [this.owner(schema), routineType.toUpperCase()] : [this.owner(schema)]
    );
    return rows.map((row) => row.OBJECT_NAME);
  }

  async getStoredProcedureDetail(procedureName: string, schema?: string): Promise<StoredProcedure> {
    const owner = this.owner(schema);
    const rows = await this.query(
      `SELECT OBJECT_NAME, OBJECT_TYPE FROM ALL_OBJECTS WHERE OWNER = ? AND OBJECT_NAME = ?
       AND OBJECT_TYPE IN ('PROCEDURE', 'FUNCTION')`,
      [owner, procedureName]
    );
    if (!rows.length) throw new Error(`Stored procedure '${procedureName}' not found`);
    const source = await this.query(
      "SELECT TEXT FROM ALL_SOURCE WHERE OWNER = ? AND NAME = ? ORDER BY LINE",
      [owner, procedureName]
    );
    return {
      procedure_name: rows[0].OBJECT_NAME,
      procedure_type: rows[0].OBJECT_TYPE === "FUNCTION" ? "function" : "procedure",
      language: "sql",
      parameter_list: "",
      definition: source.map((row) => row.TEXT).join(""),
    };
  }

  async getTableRowCount(tableName: string, schema?: string): Promise<number | null> {
    const rows = await this.query(
      "SELECT NUM_ROWS FROM ALL_TABLES WHERE OWNER = ? AND TABLE_NAME = ?",
      [this.owner(schema), tableName]
    );
    return rows[0]?.NUM_ROWS == null ? null : Number(rows[0].NUM_ROWS);
  }

  async getTableComment(tableName: string, schema?: string): Promise<string | null> {
    const rows = await this.query(
      "SELECT COMMENTS FROM ALL_TAB_COMMENTS WHERE OWNER = ? AND TABLE_NAME = ?",
      [this.owner(schema), tableName]
    );
    return rows[0]?.COMMENTS ?? null;
  }

  async executeSQL(sql: string, options: ExecuteOptions, parameters?: any[]): Promise<SQLResult> {
    const statements = splitSQLStatements(sql, "dameng");
    if (parameters?.length && statements.length !== 1) {
      throw new Error("Parameters require a single Dameng statement");
    }
    // The upstream tool handler enforces readonly before calling the connector.
    // Database permissions remain the boundary for side effects hidden in functions.
    return this.withConnection(async (conn) => {
      const resultSets: SQLResultSet[] = [];
      for (const statement of statements) {
        // dmdb sends maxRows to the server; no dialect-specific SQL rewrite needed.
        const result = await conn.execute<CatalogRow>(statement, parameters ?? [], {
          outFormat: dmdb.OUT_FORMAT_OBJECT,
          autoCommit: true,
          maxRows: options.maxRows ? options.maxRows + 1 : 0,
        });
        const rows = result.rows ?? [];
        const resultSet: SQLResultSet = {
          sql: statement,
          rows,
          rowCount: result.rowsAffected ?? rows.length,
        };
        SQLRowLimiter.flagTruncation(resultSet, options.maxRows, !!options.maxRows);
        resultSets.push(resultSet);
      }
      return { resultSets };
    });
  }
}

ConnectorRegistry.register(new DamengConnector());
