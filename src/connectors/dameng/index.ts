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
  HealthCheckResult,
} from "../interface.js";
import { SafeURL } from "../../utils/safe-url.js";
import { closeQuietly } from "../../utils/resource-cleanup.js";
import { splitPLSQLStatements, LEADING_SQL_NOISE } from "../../utils/sql-parser.js";
import { SQLRowLimiter } from "../../utils/sql-row-limiter.js";

import { OracleCatalog } from "../oracle-catalog.js";
import { computeHitRatioPct } from "../health-check-utils.js";
import { isReadOnlySQL } from "../../utils/allowed-keywords.js";
import { policyFromReadonly, sqlVerdict } from "../../utils/sql-access-policy.js";

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
      poolMax: config?.poolMaxConnections ?? 4,
      connectString:
        `dm://${encodeURIComponent(url.username)}:${encodeURIComponent(url.password)}` +
        `@${url.hostname}:${url.port || 5236}?${params}`,
    };
  }
}

export class DamengConnector extends OracleCatalog implements Connector {
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
          for (const sql of splitPLSQLStatements(initScript, "dameng")) {
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

  protected async query<T>(sql: string, parameters: Record<string, string> = {}): Promise<T[]> {
    return this.withConnection(async (conn) => {
      const result = await conn.execute<T>(sql, parameters, {
        outFormat: dmdb.OUT_FORMAT_OBJECT,
      });
      return result.rows ?? [];
    });
  }

  protected schemaOrDefault(schema?: string): string {
    const owner = schema ?? this.defaultSchema;
    if (!owner) throw new Error("No Dameng schema selected");
    return owner;
  }

  async getSchemas(): Promise<string[]> {
    const rows = await this.query<CatalogRow>("SELECT USERNAME FROM ALL_USERS ORDER BY USERNAME");
    return rows.map((row) => row.USERNAME);
  }

  async getTables(schema?: string): Promise<string[]> {
    const rows = await this.query<CatalogRow>(
      "SELECT TABLE_NAME FROM ALL_TABLES WHERE OWNER = :schema ORDER BY TABLE_NAME",
      { schema: this.schemaOrDefault(schema) }
    );
    return rows.map((row) => row.TABLE_NAME);
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    const rows = await this.query<CatalogRow>(
      `SELECT COUNT(*) AS CNT FROM ALL_OBJECTS
       WHERE OWNER = :schema AND OBJECT_NAME = :name AND OBJECT_TYPE IN ('TABLE', 'VIEW')`,
      { schema: this.schemaOrDefault(schema), name: tableName }
    );
    return Number(rows[0].CNT) > 0;
  }

  async getHealthCheck(): Promise<HealthCheckResult> {
    if (!this.pool) throw new Error("Not connected to Dameng");
    const result: HealthCheckResult = {};
    const notes: string[] = [];
    try {
      const [row] = await this.query<CatalogRow>(
        `SELECT COUNT(*) AS TOTAL,
                SUM(CASE WHEN STATE = 'ACTIVE' THEN 1 ELSE 0 END) AS ACTIVE,
                SUM(CASE WHEN STATE = 'IDLE' THEN 1 ELSE 0 END) AS IDLE,
                SUM(CASE WHEN STATE = 'IDLE' AND TRX_ID <> 0 THEN 1 ELSE 0 END) AS IDLE_IN_TRANSACTION
         FROM V$SESSIONS WHERE SESS_ID <> SESSID`
      );
      result.connections = {
        total: Number(row.TOTAL),
        active: Number(row.ACTIVE ?? 0),
        idle: Number(row.IDLE ?? 0),
        idleInTransaction: Number(row.IDLE_IN_TRANSACTION ?? 0),
        maxConnections: null,
        longestIdleInTransactionSeconds: null,
        longestActiveQuerySeconds: null,
      };
      notes.push("Dameng session-duration metrics are unavailable; durations are null.");
      try {
        const [limit] = await this.query<CatalogRow>(
          "SELECT PARA_VALUE FROM V$DM_INI WHERE PARA_NAME = 'MAX_SESSIONS'"
        );
        const ceiling = Number(limit?.PARA_VALUE);
        result.connections.maxConnections = ceiling > 0 ? ceiling : null;
      } catch {
        notes.push("Connection limit unavailable: cannot read V$DM_INI.");
      }
    } catch {
      notes.push("Session metrics unavailable: cannot read V$SESSIONS.");
    }
    try {
      const [row] = await this.query<CatalogRow>(
        "SELECT SUM(N_LOGIC_READS) AS HITS, SUM(N_PHY_READS) AS MISSES FROM V$BUFFERPOOL"
      );
      // DM counts cache hits in N_LOGIC_READS, unlike Oracle's total logical reads.
      const hits = Number(row.HITS ?? 0),
        misses = Number(row.MISSES ?? 0);
      result.bufferCache = {
        hitRatioPct: computeHitRatioPct(hits + misses, misses),
        blocksHit: hits,
        blocksRead: misses,
      };
    } catch {
      notes.push("Buffer cache metrics unavailable: cannot read V$BUFFERPOOL.");
    }
    if (notes.length) result.notes = notes;
    return result;
  }

  async executeSQL(sql: string, options: ExecuteOptions, parameters?: any[]): Promise<SQLResult> {
    const statements = splitPLSQLStatements(sql, "dameng");
    if (options.readonly && sqlVerdict(policyFromReadonly(true), sql, "dameng") !== "allow") {
      throw new Error("Read-only mode: statement is not allowed");
    }
    if (parameters?.length && statements.length !== 1) {
      throw new Error("Parameters require a single Dameng statement");
    }
    // The upstream tool handler enforces readonly before calling the connector.
    // Database permissions remain the boundary for side effects hidden in functions.
    return this.withConnection(async (conn) => {
      const resultSets: SQLResultSet[] = [];
      for (const statement of statements) {
        const afterNoise = statement.replace(LEADING_SQL_NOISE, "");
        if (/^explain\b/i.test(afterNoise)) {
          if (parameters?.length) {
            throw new Error("Dameng EXPLAIN does not support bound parameters");
          }
          const inner = afterNoise.replace(/^explain\b\s*(?:for\b\s*)?/i, "");
          // Only a single read statement can be explained. Never accept ANALYZE,
          // named plans, PL/SQL, or DML through this diagnostic path.
          if (
            statements.length !== 1 ||
            !/^(?:select|with)\b/i.test(inner.replace(LEADING_SQL_NOISE, "")) ||
            !isReadOnlySQL(inner, "dameng")
          ) {
            throw new Error("EXPLAIN requires a single read statement (SELECT or WITH)");
          }
          const result = await conn.execute<CatalogRow>(`EXPLAIN FOR ${inner}`, [], {
            outFormat: dmdb.OUT_FORMAT_OBJECT,
          });
          if (!result.rows?.length) throw new Error("Dameng returned no execution plan");
          resultSets.push({ sql: statement, rows: result.rows, rowCount: result.rows.length });
          continue;
        }
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
