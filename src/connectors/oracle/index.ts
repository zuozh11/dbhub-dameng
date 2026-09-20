import oracledb from "oracledb";
import { OracleCatalog } from "../oracle-catalog.js";
import {
  Connector,
  ConnectorType,
  ConnectorRegistry,
  DSNParser,
  SQLResult,
  SQLResultSet,
  ExecuteOptions,
  ConnectorConfig,
  HealthCheckResult,
} from "../interface.js";
import { computeHitRatioPct, toNullableNumber } from "../health-check-utils.js";
import { SafeURL } from "../../utils/safe-url.js";
import { obfuscateDSNPassword } from "../../utils/dsn-obfuscate.js";
import { SQLRowLimiter } from "../../utils/sql-row-limiter.js";
import {
  LEADING_SQL_NOISE,
  splitPLSQLStatements,
  blankCommentsAndStrings,
  stripCommentsAndStrings,
} from "../../utils/sql-parser.js";
import { isReadOnlySQL } from "../../utils/allowed-keywords.js";
import { closeQuietly } from "../../utils/resource-cleanup.js";

/** What the DSN parser hands to the connector. */
export interface OracleConnectionConfig {
  /** Passed straight to oracledb.createPool */
  pool: oracledb.PoolAttributes;
  /** Per-statement round-trip timeout, in milliseconds */
  callTimeoutMs?: number;
}

/**
 * Oracle DSN parser
 * Expected format: oracle://user:password@host:1521/service_name
 *
 * The path is the service name (the normal way to address a pluggable
 * database, e.g. FREEPDB1). An old-style SID can be given instead with
 * `?sid=ORCL`. `sslmode=require` switches the transport to TCPS without
 * certificate DN checks; `sslmode=verify-full` also checks the DN.
 */
export class OracleDSNParser implements DSNParser {
  async parse(dsn: string, config?: ConnectorConfig): Promise<OracleConnectionConfig> {
    if (!this.isValidDSN(dsn)) {
      throw new Error(
        `Invalid Oracle DSN format.\nProvided: ${obfuscateDSNPassword(dsn)}\nExpected: ${this.getSampleDSN()}`
      );
    }

    try {
      const url = new SafeURL(dsn);

      let sslmode: string | undefined;
      let sid: string | undefined;
      url.forEachSearchParam((value, key) => {
        if (key === "sslmode") {
          sslmode = value;
        } else if (key === "sid") {
          sid = value;
        }
      });

      if (sslmode !== undefined && !["disable", "require", "verify-full"].includes(sslmode)) {
        throw new Error(
          `Unsupported sslmode '${sslmode}' for Oracle. Supported: disable, require, verify-full`
        );
      }

      const host = url.hostname;
      const port = url.port ? parseInt(url.port, 10) : 1521;
      const service = url.pathname ? url.pathname.substring(1) : "";
      if (!host) {
        throw new Error("Oracle DSN must include a host");
      }
      if (!service && !sid) {
        throw new Error("Oracle DSN must include a service name in the path (or ?sid=)");
      }

      const useTls = sslmode === "require" || sslmode === "verify-full";
      let connectString: string;
      if (sid) {
        // Easy Connect has no SID form; use a full connect descriptor.
        const protocol = useTls ? "TCPS" : "TCP";
        connectString =
          `(DESCRIPTION=(ADDRESS=(PROTOCOL=${protocol})(HOST=${host})(PORT=${port}))` +
          `(CONNECT_DATA=(SID=${sid})))`;
      } else {
        connectString = `${useTls ? "tcps://" : ""}${host}:${port}/${service}`;
      }

      const pool: oracledb.PoolAttributes = {
        user: url.username,
        password: url.password,
        connectString,
        poolMin: 0,
        poolMax: config?.poolMaxConnections ?? 4,
        poolIncrement: 1,
      };
      if (config?.connectionTimeoutSeconds !== undefined) {
        pool.connectTimeout = config.connectionTimeoutSeconds;
      }
      if (useTls) {
        pool.sslServerDNMatch = sslmode === "verify-full";
      }

      return {
        pool,
        ...(config?.queryTimeoutSeconds !== undefined && {
          callTimeoutMs: config.queryTimeoutSeconds * 1000,
        }),
      };
    } catch (error) {
      throw new Error(
        `Failed to parse Oracle DSN: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getSampleDSN(): string {
    return "oracle://username:password@localhost:1521/FREEPDB1?sslmode=disable";
  }

  isValidDSN(dsn: string): boolean {
    return dsn.startsWith("oracle://");
  }
}

/**
 * Oracle connector, built on node-oracledb's Thin mode (pure JavaScript, no
 * Oracle Instant Client needed).
 *
 * Identifier case: Oracle folds unquoted identifiers to upper case, so the
 * catalog stores `users` as `USERS`. Metadata lookups apply the same folding
 * (see foldIdentifier) so callers can pass the names they wrote in their DDL;
 * names are returned exactly as the catalog holds them.
 */
export class OracleConnector extends OracleCatalog implements Connector {
  id: ConnectorType = "oracle";
  name = "Oracle";
  dsnParser = new OracleDSNParser();

  private pool?: oracledb.Pool;
  private callTimeoutMs?: number;
  /** CURRENT_SCHEMA of the connected session, resolved once at connect time */
  private defaultSchema = "";
  // Source ID is set by ConnectorManager after cloning
  private sourceId: string = "default";

  getId(): string {
    return this.sourceId;
  }

  clone(): Connector {
    return new OracleConnector();
  }

  async connect(dsn: string, initScript?: string, config?: ConnectorConfig): Promise<void> {
    try {
      const parsed = await this.dsnParser.parse(dsn, config);
      this.callTimeoutMs = parsed.callTimeoutMs;
      this.pool = await oracledb.createPool(parsed.pool);

      // Resolve the session's default schema once; it doubles as the
      // connection smoke test so a bad credential fails here, not on first use.
      const rows = await this.query<{ SCHEMA_NAME: string }>(
        "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS schema_name FROM dual"
      );
      this.defaultSchema = rows[0]?.SCHEMA_NAME ?? OracleConnector.foldIdentifier(parsed.pool.user ?? "");

      if (initScript) {
        await this.executeSQL(initScript, {});
      }
    } catch (error) {
      // Tear down the pool if it was created before the failure, otherwise it
      // strands sockets and keeps the event loop alive (see closeQuietly).
      await closeQuietly(() => this.disconnect());
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      const pool = this.pool;
      this.pool = undefined;
      await pool.close(0);
    }
  }

  /** Check out a pooled connection with the configured statement timeout applied. */
  private async acquire(): Promise<oracledb.Connection> {
    if (!this.pool) {
      throw new Error("Not connected to Oracle database");
    }
    const connection = await this.pool.getConnection();
    if (this.callTimeoutMs !== undefined) {
      connection.callTimeout = this.callTimeoutMs;
    }
    return connection;
  }

  /** Run one or more catalog queries on a single short-lived pooled connection. */
  private async withConnection<R>(fn: (connection: oracledb.Connection) => Promise<R>): Promise<R> {
    const connection = await this.acquire();
    try {
      return await fn(connection);
    } finally {
      await connection.close();
    }
  }

  private static async fetchRows<T>(
    connection: oracledb.Connection,
    sql: string,
    binds: oracledb.BindParameters = {}
  ): Promise<T[]> {
    const result = await connection.execute<T>(sql, binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      fetchTypeHandler: OracleConnector.fetchTypeHandler,
    });
    return result.rows ?? [];
  }

  /** Run one catalog query on a short-lived pooled connection. */
  protected query<T>(sql: string, binds: oracledb.BindParameters = {}): Promise<T[]> {
    return this.withConnection((connection) => OracleConnector.fetchRows<T>(connection, sql, binds));
  }

  /**
   * Per-column fetch rules:
   * - CLOB/NCLOB come back as strings and BLOB as a Buffer instead of Lob
   *   streams, so result rows are plain JSON. (LONG columns such as
   *   ALL_TAB_COLUMNS.DATA_DEFAULT are already fetched as strings by default.)
   * - NUMBER is fetched as its exact decimal string and converted here:
   *   integers within Number's safe range become numbers, larger integers
   *   become BigInt (the response serializer renders those as strings), and
   *   anything with a fraction or exponent becomes a number. The driver's
   *   default would round a NUMBER(20) identifier above 2^53 silently.
   */
  private static fetchTypeHandler(metaData: oracledb.Metadata<unknown>): oracledb.FetchTypeResponse | undefined {
    if (metaData.dbType === oracledb.DB_TYPE_CLOB || metaData.dbType === oracledb.DB_TYPE_NCLOB) {
      return { type: oracledb.STRING };
    }
    if (metaData.dbType === oracledb.DB_TYPE_BLOB) {
      return { type: oracledb.BUFFER };
    }
    if (metaData.dbType === oracledb.DB_TYPE_NUMBER) {
      return { type: oracledb.STRING, converter: OracleConnector.convertNumber };
    }
    return undefined;
  }

  /**
   * See fetchTypeHandler. Receives the NUMBER's decimal string (the generic
   * signature is what oracledb's converter type requires). Public for unit
   * testing.
   */
  static convertNumber<T>(value: T | null): number | bigint | null {
    if (value === null || value === undefined) {
      return null;
    }
    const text = String(value);
    if (/^-?\d+$/.test(text)) {
      const asNumber = Number(text);
      return Number.isSafeInteger(asNumber) ? asNumber : BigInt(text);
    }
    return Number(text);
  }

  /**
   * The catalog spelling of an identifier a caller wrote unquoted: Oracle
   * folds those to upper case. A name that already contains an upper-case
   * letter is taken as spelled, so a case-sensitive quoted identifier like
   * "MyTable" is still reachable by its exact name. (An all-lower-case quoted
   * identifier is not; that trade keeps every catalog predicate a plain
   * equality on an indexed column.)
   */
  static foldIdentifier(name: string): string {
    return /[A-Z]/.test(name) ? name : name.toUpperCase();
  }

  protected catalogIdentifier(name: string): string {
    return OracleConnector.foldIdentifier(name);
  }

  protected schemaOrDefault(schema?: string): string {
    return schema ? OracleConnector.foldIdentifier(schema) : this.defaultSchema;
  }

  async getSchemas(): Promise<string[]> {
    try {
      // Every Oracle user is a schema; the ~35 Oracle-maintained accounts
      // (SYS, SYSTEM, XDB, ...) are noise for schema exploration, so list only
      // application users plus the session's own schema.
      const rows = await this.query<{ USERNAME: string }>(
        `SELECT username
         FROM all_users
         WHERE oracle_maintained = 'N' OR username = :current_schema
         ORDER BY username`,
        { current_schema: this.schemaOrDefault() }
      );
      return rows.map((row) => row.USERNAME);
    } catch (error) {
      throw new Error(`Failed to get schemas: ${(error as Error).message}`);
    }
  }

  async getDefaultSchema(): Promise<string | null> {
    return this.defaultSchema || null;
  }

  async getTables(schema?: string): Promise<string[]> {
    try {
      const rows = await this.query<{ TABLE_NAME: string }>(
        `SELECT table_name
         FROM all_tables
         WHERE owner = :schema
           AND nested = 'NO'
           AND secondary = 'N'
           AND (iot_type IS NULL OR iot_type = 'IOT')
           AND table_name NOT LIKE 'BIN$%'
         ORDER BY table_name`,
        { schema: this.schemaOrDefault(schema) }
      );
      return rows.map((row) => row.TABLE_NAME);
    } catch (error) {
      throw new Error(`Failed to get tables: ${(error as Error).message}`);
    }
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    try {
      const rows = await this.query<{ CNT: number }>(
        `SELECT COUNT(*) AS cnt FROM all_tables WHERE owner = :schema AND table_name = :table_name`,
        { schema: this.schemaOrDefault(schema), table_name: OracleConnector.foldIdentifier(tableName) }
      );
      return Number(rows[0]?.CNT ?? 0) > 0;
    } catch (error) {
      throw new Error(`Failed to check if table exists: ${(error as Error).message}`);
    }
  }

  async getHealthCheck(): Promise<HealthCheckResult> {
    if (!this.pool) {
      throw new Error("Not connected to Oracle database");
    }

    const notes: string[] = [];
    const result: HealthCheckResult = {};

    // V$SESSION / V$PARAMETER / V$SYSSTAT are readable only with
    // SELECT_CATALOG_ROLE (or SELECT ANY DICTIONARY); without it Oracle
    // reports ORA-00942 as if the view did not exist. Degrade per section
    // instead of failing the whole health check.
    try {
      const [sessions, params] = await this.withConnection((connection) =>
        Promise.all([
          OracleConnector.fetchRows<{
            TOTAL: number;
            ACTIVE: number;
            IDLE: number;
            IDLE_IN_TRANSACTION: number;
            LONGEST_IDLE_IN_TRANSACTION_SECONDS: number | null;
            LONGEST_ACTIVE_QUERY_SECONDS: number | null;
          }>(
            connection,
            // STATUS is ACTIVE (running a call), INACTIVE (idle), or one of
            // the transitional states KILLED / SNIPED / CACHED, which count
            // toward the total but are neither active nor idle. TADDR is
            // non-null while the session has an open transaction;
            // LAST_CALL_ET is seconds since the current call began (ACTIVE)
            // or since the last call ended (otherwise).
            `SELECT
               COUNT(*) AS total,
               SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN status = 'INACTIVE' THEN 1 ELSE 0 END) AS idle,
               SUM(CASE WHEN status = 'INACTIVE' AND taddr IS NOT NULL THEN 1 ELSE 0 END) AS idle_in_transaction,
               MAX(CASE WHEN status = 'INACTIVE' AND taddr IS NOT NULL THEN last_call_et END) AS longest_idle_in_transaction_seconds,
               MAX(CASE WHEN status = 'ACTIVE' THEN last_call_et END) AS longest_active_query_seconds
             FROM v$session
             WHERE type = 'USER'
               AND sid <> SYS_CONTEXT('USERENV', 'SID')`
          ),
          OracleConnector.fetchRows<{ VALUE: string }>(
            connection,
            `SELECT value FROM v$parameter WHERE name = 'sessions'`
          ),
        ])
      );
      const conn = sessions[0];
      const maxConnections = params.length > 0 ? Number(params[0].VALUE) : null;

      result.connections = {
        total: Number(conn.TOTAL ?? 0),
        active: Number(conn.ACTIVE ?? 0),
        idle: Number(conn.IDLE ?? 0),
        idleInTransaction: Number(conn.IDLE_IN_TRANSACTION ?? 0),
        // Oracle has no equivalent of Postgres's "idle in transaction
        // (aborted)" state: a failed statement is rolled back on its own
        // and leaves the transaction usable.
        maxConnections: maxConnections !== null && maxConnections > 0 ? maxConnections : null,
        longestIdleInTransactionSeconds: toNullableNumber(conn.LONGEST_IDLE_IN_TRANSACTION_SECONDS),
        longestActiveQuerySeconds: toNullableNumber(conn.LONGEST_ACTIVE_QUERY_SECONDS),
      };
    } catch {
      notes.push(
        "Connection pool metrics unavailable: connecting user lacks SELECT on V$SESSION / V$PARAMETER (grant SELECT_CATALOG_ROLE or SELECT ANY DICTIONARY)."
      );
    }

    try {
      const stats = await this.query<{ NAME: string; VALUE: number }>(
        `SELECT name, value FROM v$sysstat
         WHERE name IN ('db block gets', 'consistent gets', 'physical reads')`
      );
      const byName = Object.fromEntries(stats.map((row) => [row.NAME, Number(row.VALUE)]));
      // Logical reads = current-mode gets + consistent-mode gets; physical
      // reads are the subset that had to go to disk.
      const logicalReads = (byName["db block gets"] ?? 0) + (byName["consistent gets"] ?? 0);
      const physicalReads = byName["physical reads"] ?? 0;

      result.bufferCache = {
        hitRatioPct: computeHitRatioPct(logicalReads, physicalReads),
        blocksHit: logicalReads - physicalReads,
        blocksRead: physicalReads,
      };
    } catch {
      notes.push(
        "Buffer cache metrics unavailable: connecting user lacks SELECT on V$SYSSTAT (grant SELECT_CATALOG_ROLE or SELECT ANY DICTIONARY)."
      );
    }

    if (notes.length > 0) {
      result.notes = notes;
    }

    return result;
  }

  /**
   * Bind values for one statement, keyed by placeholder name. DBHub's
   * placeholders are `:1`, `:2`, ... and each names parameters[N-1]; binding
   * by name (rather than handing the driver a positional array) lets a
   * placeholder repeat (`:1 ... :1`) or appear out of order, and lets a batch
   * hand each statement only the binds it uses, since the driver rejects a
   * bind object naming a placeholder the statement lacks (NJS-097).
   */
  static bindsFor(statement: string, parameters: unknown[]): Record<string, oracledb.BindParameter> {
    const binds: Record<string, oracledb.BindParameter> = {};
    const blanked = blankCommentsAndStrings(statement, "oracle");
    for (const match of blanked.matchAll(/(?<!:):(\d+)\b/g)) {
      const index = parseInt(match[1], 10);
      if (index >= 1 && index <= parameters.length) {
        binds[match[1]] = parameters[index - 1] as oracledb.BindParameter;
      }
    }
    return binds;
  }

  /**
   * Wrap a driver error with context while keeping the properties the
   * connection-error classifier reads (`code`, `errorNum`), which a plain
   * `new Error(message)` would drop.
   */
  private static wrapError(prefix: string, error: unknown): Error {
    const wrapped = new Error(`${prefix}: ${(error as Error).message}`, { cause: error });
    for (const key of ["code", "errorNum", "offset"] as const) {
      const value = (error as Record<string, unknown> | null)?.[key];
      if (value !== undefined) {
        (wrapped as unknown as Record<string, unknown>)[key] = value;
      }
    }
    return wrapped;
  }

  async executeSQL(sqlQuery: string, options: ExecuteOptions, parameters?: any[]): Promise<SQLResult> {
    const afterNoise = sqlQuery.replace(LEADING_SQL_NOISE, "");
    if (/^explain\b/i.test(afterNoise)) {
      return this.explainQuery(afterNoise.slice("explain".length), options.readonly, parameters);
    }

    const statements = OracleConnector.splitStatements(afterNoise);

    const connection = await this.acquire();
    try {
      // Engine-level read-only enforcement: a READ ONLY transaction makes the
      // server itself reject DML (ORA-01456). DDL is not covered by it (DDL
      // implicitly commits and so ends the transaction), which is why the
      // keyword classifier in front of this connector stays the first line of
      // defense; this is the backstop behind it.
      if (options.readonly) {
        await connection.execute("SET TRANSACTION READ ONLY");
      }

      const resultSets: SQLResultSet[] = [];
      for (const statement of statements) {
        // Oracle runs one statement per round trip, so the cap is applied per statement.
        const { sql: processedSQL, probeApplied } =
          SQLRowLimiter.applyMaxRowsForOracleWithTruncationProbe(statement, options.maxRows);

        const result = await connection.execute<Record<string, unknown>>(
          processedSQL,
          OracleConnector.bindsFor(statement, parameters ?? []),
          {
            outFormat: oracledb.OUT_FORMAT_OBJECT,
            fetchTypeHandler: OracleConnector.fetchTypeHandler,
          }
        );

        const rows = result.rows ?? [];
        const resultSet: SQLResultSet = {
          sql: statement,
          rows,
          rowCount: result.rows ? rows.length : result.rowsAffected ?? 0,
        };
        SQLRowLimiter.flagTruncation(resultSet, options.maxRows, probeApplied);
        resultSets.push(resultSet);
      }

      if (options.readonly) {
        await connection.rollback();
      } else {
        await connection.commit();
      }
      return { resultSets };
    } catch (error) {
      // Best-effort rollback so a failed ROLLBACK cannot mask the original error.
      await closeQuietly(() => connection.rollback());
      throw OracleConnector.wrapError("Failed to execute query", error);
    } finally {
      await connection.close();
    }
  }

  /**
   * Split a batch into the statements Oracle executes one per round trip.
   *
   * Plain SQL ends at a top-level semicolon, which is stripped: Oracle
   * rejects a trailing `;` on a SQL statement (ORA-00933). A PL/SQL block,
   * or the DDL that creates one, *requires* its semicolons and is sent
   * whole: it ends at the `;` that closes its outermost BEGIN ... END
   * (depth-tracked over `begin`/`case` ... `end`, with `end if` / `end loop`
   * neutral), or at a SQL*Plus `/` line, which is dropped either way. The
   * scan runs on the comment/string-blanked text so nothing inside a
   * literal or comment counts.
   */
  static splitStatements(sql: string): string[] {
    return splitPLSQLStatements(sql, "oracle");
  }

  /**
   * Run `EXPLAIN PLAN FOR <statement>` and return the formatted plan.
   *
   * EXPLAIN PLAN parses and optimizes the statement without executing it. It
   * stores the plan in PLAN_TABLE (a session-private global temporary table),
   * which is why this path runs outside the READ ONLY transaction used by
   * executeSQL and cleans up its rows afterwards.
   *
   * Accepts the Postgres-style `EXPLAIN <stmt>` the explain_sql tool emits as
   * well as Oracle's own `EXPLAIN PLAN [SET STATEMENT_ID = '...'] FOR <stmt>`.
   */
  private async explainQuery(
    afterExplain: string,
    readonly?: boolean,
    parameters?: any[]
  ): Promise<SQLResult> {
    const innerQuery = afterExplain
      .replace(/^\s*plan\b(?:\s+set\s+statement_id\s*=\s*'[^']*')?\s+for\b/i, "")
      .replace(/;\s*$/, "")
      .trim();

    if (!stripCommentsAndStrings(innerQuery, "oracle").trim()) {
      throw new Error("EXPLAIN requires a statement to analyze");
    }
    // EXPLAIN is routed here before the read-only transaction is opened. The
    // explained statement is never executed, but in read-only mode it must
    // still be a read statement so this path cannot become a side channel for
    // parsing DML/DDL under a read-only tool.
    if (readonly && !isReadOnlySQL(innerQuery, "oracle")) {
      throw new Error("Read-only mode: EXPLAIN is only allowed for read statements");
    }

    // STATEMENT_ID is VARCHAR2(30); this is well within it.
    const statementId = `dbhub_${Math.random().toString(36).slice(2, 14)}`;
    return this.withConnection(async (connection) => {
      try {
        await connection.execute(
          `EXPLAIN PLAN SET STATEMENT_ID = '${statementId}' FOR ${innerQuery}`,
          OracleConnector.bindsFor(innerQuery, parameters ?? [])
        );
        const lines = await OracleConnector.fetchRows<{ PLAN_TABLE_OUTPUT: string }>(
          connection,
          "SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', :id, 'TYPICAL'))",
          { id: statementId }
        );
        const plan = lines.map((row) => row.PLAN_TABLE_OUTPUT).join("\n");
        return {
          resultSets: [
            {
              rows: lines.length > 0 ? [{ plan }] : [],
              rowCount: lines.length > 0 ? 1 : 0,
            },
          ],
        };
      } catch (error) {
        throw OracleConnector.wrapError("Failed to explain query", error);
      } finally {
        // PLAN_TABLE preserves rows for the session, and the session goes back
        // to the pool: drop this plan so it cannot pile up or leak to a later
        // caller. Best effort.
        await closeQuietly(async () => {
          await connection.execute("DELETE FROM plan_table WHERE statement_id = :id", { id: statementId });
          await connection.commit();
        });
      }
    });
  }
}

// Create and register the connector
const oracleConnector = new OracleConnector();
ConnectorRegistry.register(oracleConnector);
