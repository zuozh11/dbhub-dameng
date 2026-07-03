import dmdb from "dmdb";
import {
  Connector,
  ConnectorType,
  ConnectorRegistry,
  DSNParser,
  SQLResult,
  TableColumn,
  TableIndex,
  StoredProcedure,
  ExecuteOptions,
  ConnectorConfig,
  ColumnSearchResult,
} from "../interface.js";
import { SafeURL } from "../../utils/safe-url.js";
import { obfuscateDSNPassword } from "../../utils/dsn-obfuscate.js";
import { splitSQLStatements, stripCommentsAndStrings } from "../../utils/sql-parser.js";

interface DamengConnectionConfig {
  connectString: string;
  directConnectString?: string;
  user: string;
  password: string;
  schema?: string;
  poolAlias?: string;
  poolMin?: number;
  poolMax?: number;
  connectTimeout?: number;
  sessionTimeout?: number;
  socketTimeout?: number;
  queueRequests?: boolean;
  queueTimeout?: number;
  [key: string]: any;
}

type DamengPool = {
  poolAlias?: string;
  getConnection(): Promise<DamengConnection>;
  close(force?: number): Promise<void>;
};

type DamengConnection = {
  execute(sql: string, bindParams?: any[] | Record<string, any>, options?: Record<string, any>): Promise<any>;
  close(): Promise<void>;
  release?: () => Promise<void>;
};

const DEFAULT_OPERATION_TIMEOUT_MS = 110_000;
const RESOURCE_CLEANUP_TIMEOUT_MS = 2_000;
const CONNECT_RETRY_ATTEMPTS = 3;
const CONNECT_RETRY_DELAY_MS = 500;

class DamengOperationTimeoutError extends Error {
  constructor(
    message: string,
    public readonly label: string
  ) {
    super(message);
    this.name = "DamengOperationTimeoutError";
  }
}

class DamengDSNParser implements DSNParser {
  async parse(dsn: string, config?: ConnectorConfig): Promise<DamengConnectionConfig> {
    if (!this.isValidDSN(dsn)) {
      const obfuscatedDSN = obfuscateDSNPassword(dsn);
      const expectedFormat = this.getSampleDSN();
      throw new Error(
        `Invalid Dameng DSN format.\nProvided: ${obfuscatedDSN}\nExpected: ${expectedFormat}`
      );
    }

    try {
      const url = new SafeURL(dsn);
      const schema = url.pathname ? decodeURIComponent(url.pathname.substring(1)) : undefined;
      const port = url.port ? parseInt(url.port, 10) : 5236;

      const queryParams: Record<string, string> = {};
      const queryStringParts: string[] = [];
      url.forEachSearchParam((value, key) => {
        queryParams[key] = value;
        queryStringParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      });

      const connectionConfig: DamengConnectionConfig = {
        connectString:
          `dm://${encodeURIComponent(url.username)}:${encodeURIComponent(url.password)}` +
          `@${url.hostname}:${port}${queryStringParts.length > 0 ? `?${queryStringParts.join("&")}` : ""}`,
        directConnectString: `${url.hostname}:${port}`,
        user: url.username,
        password: url.password,
        schema: schema || undefined,
        poolMin: 0,
        poolMax: 4,
        ...queryParams,
      };

      if (config?.connectionTimeoutSeconds !== undefined) {
        connectionConfig.connectTimeout = config.connectionTimeoutSeconds * 1000;
        connectionConfig.queueTimeout = config.connectionTimeoutSeconds * 1000;
      }

      if (config?.queryTimeoutSeconds !== undefined) {
        connectionConfig.sessionTimeout = config.queryTimeoutSeconds;
        connectionConfig.socketTimeout = config.queryTimeoutSeconds * 1000 + 1000;
      }

      return connectionConfig;
    } catch (error) {
      throw new Error(
        `Failed to parse Dameng DSN: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getSampleDSN(): string {
    return "dameng://SYSDBA:password@localhost:5236/SYSDBA";
  }

  isValidDSN(dsn: string): boolean {
    try {
      return dsn.startsWith("dameng://") || dsn.startsWith("dm://");
    } catch {
      return false;
    }
  }

}

export class DamengConnector implements Connector {
  id: ConnectorType = "dameng";
  name = "Dameng";
  dsnParser = new DamengDSNParser();

  private pool: DamengPool | null = null;
  private sourceId = "default";
  private defaultSchema: string | null = null;
  private poolAlias: string | null = null;
  private connectionConfig: DamengConnectionConfig | null = null;
  private initScript: string | undefined;
  private connectionTimeoutMs = 5_000;
  private operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS;
  private reconnectingPool: Promise<void> | null = null;

  getId(): string {
    return this.sourceId;
  }

  clone(): Connector {
    return new DamengConnector();
  }

  async connect(dsn: string, initScript?: string, config?: ConnectorConfig): Promise<void> {
    for (let attempt = 1; attempt <= CONNECT_RETRY_ATTEMPTS; attempt += 1) {
      let createdPool: DamengPool | null = null;
      try {
        const connectionConfig = await this.dsnParser.parse(dsn, config);
        connectionConfig.poolAlias = this.buildPoolAlias();
        this.defaultSchema = connectionConfig.schema ?? null;
        this.poolAlias = connectionConfig.poolAlias;
        this.connectionTimeoutMs = config?.connectionTimeoutSeconds !== undefined
          ? config.connectionTimeoutSeconds * 1000
          : 5_000;
        this.operationTimeoutMs = config?.queryTimeoutSeconds !== undefined
          ? config.queryTimeoutSeconds * 1000
          : DEFAULT_OPERATION_TIMEOUT_MS;
        connectionConfig.connectTimeout ??= this.connectionTimeoutMs;
        connectionConfig.queueTimeout ??= this.connectionTimeoutMs;

        await this.closeRegisteredPool(connectionConfig.poolAlias);
        await this.validateDirectConnection(connectionConfig);

        createdPool = await dmdb.createPool(connectionConfig);
        this.pool = createdPool;
        await this.withConnection((conn) => this.initializeSession(conn, initScript));
        this.connectionConfig = connectionConfig;
        this.initScript = initScript;
        return;
      } catch (error) {
        if (createdPool) {
          await this.closePoolQuietly(createdPool);
        } else if (this.poolAlias) {
          await this.closeRegisteredPool(this.poolAlias);
        }
        this.pool = null;
        this.poolAlias = null;
        this.connectionConfig = null;
        this.initScript = undefined;

        if (attempt < CONNECT_RETRY_ATTEMPTS && this.isRetryableConnectFailure(error)) {
          console.error(
            `Retrying Dameng source '${this.sourceId}' connection after transient failure ` +
            `(${attempt}/${CONNECT_RETRY_ATTEMPTS}): ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          await this.delay(CONNECT_RETRY_DELAY_MS * attempt);
          continue;
        }

        console.error("Failed to connect to Dameng database:", error);
        throw error;
      }
    }

    throw new Error("Failed to connect to Dameng database");
  }

  private async initializeSession(conn: DamengConnection, initScript?: string): Promise<void> {
    await this.executeWithTimeout(
      conn,
      "SELECT 1 AS OK",
      [],
      this.executeOptions()
    );
    if (!this.defaultSchema) {
      const result = await this.executeWithTimeout(
        conn,
        "SELECT USER AS SCHEMA_NAME FROM DUAL",
        [],
        this.executeOptions()
      );
      this.defaultSchema = this.rowValue(result.rows?.[0], "SCHEMA_NAME") ?? null;
    }
    if (initScript) {
      for (const statement of splitSQLStatements(initScript, "dameng")) {
        await this.executeWithTimeout(
          conn,
          statement,
          [],
          this.executeOptions({ autoCommit: true })
        );
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.closePoolQuietly(this.pool);
      this.pool = null;
    }
    if (this.poolAlias) {
      await this.closeRegisteredPool(this.poolAlias);
      this.poolAlias = null;
    }
    this.connectionConfig = null;
    this.initScript = undefined;
    this.reconnectingPool = null;
  }

  async getSchemas(): Promise<string[]> {
    const rows = await this.queryRows(`
      SELECT USERNAME AS SCHEMA_NAME
      FROM ALL_USERS
      WHERE USERNAME NOT IN ('SYS', 'SYSTEM', 'SYSAUDITOR', 'SYSSSO', 'CTISYS')
      ORDER BY USERNAME
    `);
    return rows.map((row) => this.rowValue(row, "SCHEMA_NAME")).filter(this.isPresent);
  }

  async schemaExists(schema: string): Promise<boolean> {
    const rows = await this.queryRows(
      `
      SELECT COUNT(*) AS CNT
      FROM ALL_USERS
      WHERE USERNAME = :1
      `,
      [this.normalizeIdentifier(schema)]
    );
    return Number(this.rowValue(rows[0], "CNT") ?? 0) > 0;
  }

  async getDefaultSchema(): Promise<string | null> {
    return this.defaultSchema;
  }

  async getTables(schema?: string): Promise<string[]> {
    const owner = await this.resolveSchema(schema);
    const rows = await this.queryRows(
      `
      SELECT TABLE_NAME
      FROM ALL_TABLES
      WHERE OWNER = :1
      ORDER BY TABLE_NAME
      `,
      [owner]
    );
    return rows.map((row) => this.rowValue(row, "TABLE_NAME")).filter(this.isPresent);
  }

  async searchTables(
    pattern: string,
    schema?: string,
    limit = 100
  ): Promise<Array<{ name: string; schema: string }>> {
    const owner = await this.resolveSchema(schema);
    const rowLimit = this.normalizeLimit(limit);
    const rows = await this.queryRows(
      `
      SELECT TABLE_NAME
      FROM (
        SELECT TABLE_NAME
        FROM ALL_TABLES
        WHERE OWNER = :1
          AND TABLE_NAME LIKE :2
        ORDER BY TABLE_NAME
      )
      WHERE ROWNUM <= ${rowLimit}
      `,
      [owner, this.normalizeLikePattern(pattern)]
    );
    return rows
      .map((row) => this.rowValue(row, "TABLE_NAME"))
      .filter(this.isPresent)
      .map((name) => ({ name, schema: owner }));
  }

  async searchColumns(
    pattern: string,
    schema?: string,
    table?: string,
    limit = 100
  ): Promise<ColumnSearchResult[]> {
    const owner = await this.resolveSchema(schema);
    const rowLimit = this.normalizeLimit(limit);
    const bindValues = [
      owner,
      this.normalizeLikePattern(pattern),
      ...(table ? [this.normalizeIdentifier(table)] : []),
    ];
    const tablePredicate = table ? "AND c.TABLE_NAME = :3" : "";
    const rows = await this.queryRows(
      `
      SELECT COLUMN_NAME,
             TABLE_NAME,
             DATA_TYPE,
             DATA_LENGTH,
             DATA_PRECISION,
             DATA_SCALE,
             NULLABLE,
             DATA_DEFAULT,
             COMMENTS
      FROM (
        SELECT c.COLUMN_NAME,
               c.TABLE_NAME,
               c.DATA_TYPE,
               c.DATA_LENGTH,
               c.DATA_PRECISION,
               c.DATA_SCALE,
               c.NULLABLE,
               c.DATA_DEFAULT,
               cc.COMMENTS,
               c.COLUMN_ID
        FROM ALL_TAB_COLUMNS c
        LEFT JOIN ALL_COL_COMMENTS cc
          ON cc.OWNER = c.OWNER
         AND cc.TABLE_NAME = c.TABLE_NAME
         AND cc.COLUMN_NAME = c.COLUMN_NAME
        WHERE c.OWNER = :1
          AND c.COLUMN_NAME LIKE :2
          ${tablePredicate}
        ORDER BY c.TABLE_NAME, c.COLUMN_ID
      )
      WHERE ROWNUM <= ${rowLimit}
      `,
      bindValues
    );

    return rows.map((row) => {
      const description = this.rowValue(row, "COMMENTS");
      return {
        name: this.rowValue(row, "COLUMN_NAME") ?? "",
        table: this.rowValue(row, "TABLE_NAME") ?? "",
        schema: owner,
        type: this.formatDataType(row),
        nullable: this.rowValue(row, "NULLABLE") === "Y",
        default: this.rowValue(row, "DATA_DEFAULT") ?? null,
        ...(description ? { description } : {}),
      };
    });
  }

  async getViews(schema?: string): Promise<string[]> {
    const owner = await this.resolveSchema(schema);
    const rows = await this.queryRows(
      `
      SELECT VIEW_NAME
      FROM ALL_VIEWS
      WHERE OWNER = :1
      ORDER BY VIEW_NAME
      `,
      [owner]
    );
    return rows.map((row) => this.rowValue(row, "VIEW_NAME")).filter(this.isPresent);
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    const owner = await this.resolveSchema(schema);
    const rows = await this.queryRows(
      `
      SELECT COUNT(*) AS CNT
      FROM ALL_OBJECTS
      WHERE OWNER = :1
        AND OBJECT_NAME = :2
        AND OBJECT_TYPE IN ('TABLE', 'VIEW')
      `,
      [owner, this.normalizeIdentifier(tableName)]
    );
    return Number(this.rowValue(rows[0], "CNT") ?? 0) > 0;
  }

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    const owner = await this.resolveSchema(schema);
    const rows = await this.queryRows(
      `
      SELECT c.COLUMN_NAME,
             c.DATA_TYPE,
             c.DATA_LENGTH,
             c.DATA_PRECISION,
             c.DATA_SCALE,
             c.NULLABLE,
             c.DATA_DEFAULT,
             cc.COMMENTS
      FROM ALL_TAB_COLUMNS c
      LEFT JOIN ALL_COL_COMMENTS cc
        ON cc.OWNER = c.OWNER
       AND cc.TABLE_NAME = c.TABLE_NAME
       AND cc.COLUMN_NAME = c.COLUMN_NAME
      WHERE c.OWNER = :1
        AND c.TABLE_NAME = :2
      ORDER BY c.COLUMN_ID
      `,
      [owner, this.normalizeIdentifier(tableName)]
    );

    return rows.map((row) => {
      const dataType = this.formatDataType(row);
      return {
        column_name: this.rowValue(row, "COLUMN_NAME") ?? "",
        data_type: dataType,
        is_nullable: this.rowValue(row, "NULLABLE") === "Y" ? "YES" : "NO",
        column_default: this.rowValue(row, "DATA_DEFAULT") ?? null,
        description: this.rowValue(row, "COMMENTS") ?? null,
      };
    });
  }

  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    const owner = await this.resolveSchema(schema);
    const rows = await this.queryRows(
      `
      SELECT i.INDEX_NAME,
             i.UNIQUENESS,
             ic.COLUMN_NAME,
             ic.COLUMN_POSITION,
             CASE WHEN c.CONSTRAINT_TYPE = 'P' THEN 1 ELSE 0 END AS IS_PRIMARY
      FROM ALL_INDEXES i
      JOIN ALL_IND_COLUMNS ic
        ON i.OWNER = ic.INDEX_OWNER
       AND i.INDEX_NAME = ic.INDEX_NAME
      LEFT JOIN ALL_CONSTRAINTS c
        ON c.OWNER = i.TABLE_OWNER
       AND c.TABLE_NAME = i.TABLE_NAME
       AND c.INDEX_NAME = i.INDEX_NAME
       AND c.CONSTRAINT_TYPE = 'P'
      WHERE i.TABLE_OWNER = :1
        AND i.TABLE_NAME = :2
      ORDER BY i.INDEX_NAME, ic.COLUMN_POSITION
      `,
      [owner, this.normalizeIdentifier(tableName)]
    );

    const indexMap = new Map<string, TableIndex>();
    for (const row of rows) {
      const indexName = this.rowValue(row, "INDEX_NAME") ?? "";
      if (!indexMap.has(indexName)) {
        indexMap.set(indexName, {
          index_name: indexName,
          column_names: [],
          is_unique: this.rowValue(row, "UNIQUENESS") === "UNIQUE",
          is_primary: Number(this.rowValue(row, "IS_PRIMARY") ?? 0) === 1,
        });
      }
      const columnName = this.rowValue(row, "COLUMN_NAME");
      if (columnName) {
        indexMap.get(indexName)!.column_names.push(columnName);
      }
    }
    return Array.from(indexMap.values());
  }

  async getStoredProcedures(schema?: string, routineType?: "procedure" | "function"): Promise<string[]> {
    const owner = await this.resolveSchema(schema);
    const types = routineType
      ? [routineType === "procedure" ? "PROCEDURE" : "FUNCTION"]
      : ["PROCEDURE", "FUNCTION"];
    const rows = await this.queryRows(
      `
      SELECT OBJECT_NAME
      FROM ALL_OBJECTS
      WHERE OWNER = :1
        AND OBJECT_TYPE IN (${types.map((_, i) => `:${i + 2}`).join(", ")})
      ORDER BY OBJECT_NAME
      `,
      [owner, ...types]
    );
    return rows.map((row) => this.rowValue(row, "OBJECT_NAME")).filter(this.isPresent);
  }

  async getStoredProcedureDetail(procedureName: string, schema?: string): Promise<StoredProcedure> {
    const owner = await this.resolveSchema(schema);
    const name = this.normalizeIdentifier(procedureName);
    const rows = await this.queryRows(
      `
      SELECT OBJECT_NAME, OBJECT_TYPE
      FROM ALL_OBJECTS
      WHERE OWNER = :1
        AND OBJECT_NAME = :2
        AND OBJECT_TYPE IN ('PROCEDURE', 'FUNCTION')
      `,
      [owner, name]
    );
    if (rows.length === 0) {
      throw new Error(`Stored procedure '${procedureName}' not found in ${owner}`);
    }

    const sourceRows = await this.queryRows(
      `
      SELECT TEXT
      FROM ALL_SOURCE
      WHERE OWNER = :1
        AND NAME = :2
      ORDER BY LINE
      `,
      [owner, name]
    );
    const objectType = this.rowValue(rows[0], "OBJECT_TYPE") ?? "PROCEDURE";
    return {
      procedure_name: this.rowValue(rows[0], "OBJECT_NAME") ?? procedureName,
      procedure_type: objectType === "FUNCTION" ? "function" : "procedure",
      language: "sql",
      parameter_list: "",
      definition: sourceRows.map((row) => this.rowValue(row, "TEXT") ?? "").join(""),
    };
  }

  async getTableRowCount(tableName: string, schema?: string): Promise<number | null> {
    const owner = await this.resolveSchema(schema);
    const rows = await this.queryRows(
      `
      SELECT NUM_ROWS
      FROM ALL_TABLES
      WHERE OWNER = :1
        AND TABLE_NAME = :2
      `,
      [owner, this.normalizeIdentifier(tableName)]
    );
    const value = this.rowValue(rows[0], "NUM_ROWS");
    return value === null || value === undefined ? null : Number(value);
  }

  async getTableComment(tableName: string, schema?: string): Promise<string | null> {
    const owner = await this.resolveSchema(schema);
    const rows = await this.queryRows(
      `
      SELECT COMMENTS
      FROM ALL_TAB_COMMENTS
      WHERE OWNER = :1
        AND TABLE_NAME = :2
      `,
      [owner, this.normalizeIdentifier(tableName)]
    );
    return this.rowValue(rows[0], "COMMENTS") ?? null;
  }

  async executeSQL(sql: string, options: ExecuteOptions, parameters?: any[]): Promise<SQLResult> {
    if (!this.pool) {
      throw new Error("Not connected to Dameng database");
    }

    return this.withConnection(async (conn) => {
      const statements = splitSQLStatements(sql, "dameng");
      const allRows: any[] = [];
      let rowCount = 0;

      for (const [index, statement] of statements.entries()) {
        const processedSQL = this.applyMaxRows(statement, options.maxRows);
        const { sql: boundSQL, bindValues } = this.replacePositionalParameters(
          processedSQL,
          index === 0 ? parameters ?? [] : []
        );
        const result = await this.executeWithTimeout(
          conn,
          boundSQL,
          this.toBindParams(bindValues),
          this.executeOptions({ autoCommit: true, maxRows: options.maxRows })
        );
        const rows = this.normalizeRows(result.rows ?? []);
        allRows.push(...rows);
        rowCount += Number(result.rowsAffected ?? rows.length ?? 0);
      }

      return { rows: allRows, rowCount };
    });
  }

  private async queryRows(sql: string, bindValues: any[] = []): Promise<any[]> {
    return this.withConnection(async (conn) => {
      const result = await this.executeWithTimeout(
        conn,
        sql,
        this.toBindParams(bindValues),
        this.executeOptions()
      );
      return this.normalizeRows(result.rows ?? []);
    });
  }

  private async withConnection<T>(fn: (conn: DamengConnection) => Promise<T>): Promise<T> {
    try {
      return await this.withConnectionAttempt(fn);
    } catch (error) {
      if (!this.isConnectionAcquisitionFailure(error)) {
        throw error;
      }

      console.error(
        `Retrying Dameng source '${this.sourceId}' after connection acquisition failure: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      await this.ensurePool();
      return this.withConnectionAttempt(fn);
    }
  }

  private async withConnectionAttempt<T>(fn: (conn: DamengConnection) => Promise<T>): Promise<T> {
    await this.ensurePool();
    const pool = this.pool;
    if (!pool) {
      throw new Error("Not connected to Dameng database");
    }

    let conn: DamengConnection | null = null;
    let shouldRelease = true;
    try {
      conn = await this.acquireConnectionWithTimeout(pool);
      return await fn(conn);
    } catch (error) {
      if (error instanceof DamengOperationTimeoutError) {
        shouldRelease = false;
        this.markPoolUnhealthy(error.message);
      } else if (!conn && this.isConnectionAcquisitionFailure(error)) {
        shouldRelease = false;
        this.markPoolUnhealthy(error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      if (conn && shouldRelease) {
        await this.releaseConnectionQuietly(conn);
      }
    }
  }

  private async acquireConnectionWithTimeout(pool: DamengPool): Promise<DamengConnection> {
    const acquisition = pool.getConnection();
    try {
      return await this.withTimeout(
        acquisition,
        this.connectionTimeoutMs,
        "Dameng connection acquisition"
      );
    } catch (error) {
      if (error instanceof DamengOperationTimeoutError) {
        void acquisition
          .then((conn) => this.releaseConnectionQuietly(conn))
          .catch(() => undefined);
      }
      throw error;
    }
  }

  private async ensurePool(): Promise<void> {
    if (this.pool) {
      return;
    }
    if (!this.connectionConfig) {
      throw new Error("Not connected to Dameng database");
    }
    if (!this.reconnectingPool) {
      this.reconnectingPool = this.reconnectPool();
    }
    try {
      await this.reconnectingPool;
    } finally {
      this.reconnectingPool = null;
    }
  }

  private async reconnectPool(): Promise<void> {
    const config = this.connectionConfig;
    if (!config) {
      throw new Error("Not connected to Dameng database");
    }

    console.error(`Reconnecting Dameng source '${this.sourceId}' after pool reset...`);
    await this.closeRegisteredPool(config.poolAlias ?? this.buildPoolAlias());
    await this.validateDirectConnection(config);

    const createdPool = await dmdb.createPool(config);
    this.pool = createdPool;
    this.poolAlias = config.poolAlias ?? null;

    try {
      await this.withConnection(async (conn) => {
        await this.executeWithTimeout(conn, "SELECT 1 AS OK", [], this.executeOptions());
        if (this.initScript) {
          for (const statement of splitSQLStatements(this.initScript, "dameng")) {
            await this.executeWithTimeout(
              conn,
              statement,
              [],
              this.executeOptions({ autoCommit: true })
            );
          }
        }
      });
    } catch (error) {
      await this.closePoolQuietly(createdPool);
      this.pool = null;
      throw error;
    }
  }

  private executeWithTimeout(
    conn: DamengConnection,
    sql: string,
    bindParams: any[] | Record<string, any>,
    options: Record<string, any>
  ): Promise<any> {
    return this.withTimeout(
      conn.execute(sql, bindParams, options),
      this.operationTimeoutMs,
      "Dameng SQL execution"
    );
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return promise;
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new DamengOperationTimeoutError(`${label} timed out after ${timeoutMs}ms`, label));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private markPoolUnhealthy(reason: string): void {
    const pool = this.pool;
    this.pool = null;
    console.error(`Resetting Dameng source '${this.sourceId}' pool: ${reason}`);
    if (pool) {
      void this.closePoolQuietly(pool);
    }
  }

  private async releaseConnectionQuietly(conn: DamengConnection): Promise<void> {
    try {
      const release = conn.release ? conn.release() : conn.close();
      await this.withTimeout(
        release,
        RESOURCE_CLEANUP_TIMEOUT_MS,
        "Dameng connection release"
      );
    } catch (error) {
      this.markPoolUnhealthy(
        `failed to release connection: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private isConnectionAcquisitionFailure(error: unknown): boolean {
    if (error instanceof DamengOperationTimeoutError) {
      return error.label === "Dameng connection acquisition";
    }

    const message = error instanceof Error ? error.message : String(error);
    return [
      "Connection request timeout in queue",
      "Pool cannot open more connections",
      "获取连接请求等待超时",
      "连接池已达到最大连接数",
    ].some((item) => message.includes(item));
  }

  private isRetryableConnectFailure(error: unknown): boolean {
    if (error instanceof DamengOperationTimeoutError) {
      return [
        "Dameng direct connection",
        "Dameng connection acquisition",
        "Dameng SQL execution",
      ].includes(error.label);
    }

    const message = error instanceof Error ? error.message : String(error);
    return [
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "socket hang up",
      "Socket timeout",
      "connect timeout",
      "Connection request timeout in queue",
      "Pool cannot open more connections",
      "网络通讯超时",
      "网络通信异常",
      "连接超时",
      "获取连接请求等待超时",
      "连接池已达到最大连接数",
    ].some((item) => message.includes(item));
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private executeOptions(extra: Record<string, any> = {}): Record<string, any> {
    return {
      outFormat: dmdb.OUT_FORMAT_OBJECT,
      ...extra,
    };
  }

  private async validateDirectConnection(config: DamengConnectionConfig): Promise<void> {
    let conn: DamengConnection | null = null;
    try {
      const {
        directConnectString,
        poolAlias,
        poolMin,
        poolMax,
        queueRequests,
        queueTimeout,
        ...directConfig
      } = config;
      const directConn = await this.withTimeout(
        dmdb.getConnection({
          ...directConfig,
          connectString: directConnectString ?? config.connectString,
        }) as Promise<DamengConnection>,
        this.connectionTimeoutMs,
        "Dameng direct connection"
      );
      conn = directConn;
      await this.executeWithTimeout(conn, "SELECT 1 AS OK", [], this.executeOptions());
    } finally {
      if (conn) {
        await this.releaseConnectionQuietly(conn);
      }
    }
  }

  private buildPoolAlias(): string {
    const safeSourceId = this.sourceId.replace(/[^a-zA-Z0-9_-]/g, "_") || "default";
    return `dbhub_dameng_${safeSourceId}`;
  }

  private async closeRegisteredPool(poolAlias: string): Promise<void> {
    if (!dmdb.pools?.has?.(poolAlias)) {
      return;
    }
    const pool = dmdb.pools.get(poolAlias) as DamengPool;
    await this.closePoolQuietly(pool);
    dmdb.pools?.delete?.(poolAlias);
  }

  private async closePoolQuietly(pool: DamengPool): Promise<void> {
    try {
      await this.withTimeout(pool.close(0), RESOURCE_CLEANUP_TIMEOUT_MS, "Dameng pool close");
    } catch {
      if (pool.poolAlias) {
        dmdb.pools?.delete?.(pool.poolAlias);
      }
    }
  }

  private async resolveSchema(schema?: string): Promise<string> {
    const resolved = schema || this.defaultSchema || await this.getDefaultSchema();
    if (!resolved) {
      throw new Error("No Dameng schema specified and current schema could not be resolved");
    }
    return this.normalizeIdentifier(resolved);
  }

  private normalizeIdentifier(identifier: string): string {
    return /[a-z]/.test(identifier) ? identifier.toUpperCase() : identifier;
  }

  private normalizeLikePattern(pattern: string): string {
    return /[a-z]/.test(pattern) ? pattern.toUpperCase() : pattern;
  }

  private normalizeLimit(limit: number): number {
    return Math.max(1, Math.min(1000, Math.floor(limit)));
  }

  private normalizeRows(rows: any[]): any[] {
    return rows.map((row) => {
      if (!Array.isArray(row)) {
        return row;
      }
      return row;
    });
  }

  private rowValue(row: any, key: string): string | null {
    if (!row) {
      return null;
    }
    return row[key] ?? row[key.toLowerCase()] ?? row[key.toUpperCase()] ?? null;
  }

  private isPresent(value: string | null): value is string {
    return value !== null && value !== "";
  }

  private formatDataType(row: any): string {
    const dataType = this.rowValue(row, "DATA_TYPE") ?? "";
    const precision = this.rowValue(row, "DATA_PRECISION");
    const scale = this.rowValue(row, "DATA_SCALE");
    const length = this.rowValue(row, "DATA_LENGTH");

    if (precision !== null && precision !== undefined) {
      return scale !== null && scale !== undefined
        ? `${dataType}(${precision},${scale})`
        : `${dataType}(${precision})`;
    }
    if (length !== null && length !== undefined && /CHAR|VARCHAR|BINARY/i.test(dataType)) {
      return `${dataType}(${length})`;
    }
    return dataType;
  }

  private toBindParams(values: any[]): any[] {
    return values.map((value) => ({ val: value }));
  }

  private applyMaxRows(sql: string, maxRows?: number): string {
    if (!maxRows) {
      return sql;
    }
    const cleaned = stripCommentsAndStrings(sql, "dameng").trim().toLowerCase();
    if (!cleaned.startsWith("select")) {
      return sql;
    }
    const trimmed = sql.trim();
    const withoutSemicolon = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
    return `SELECT * FROM (${withoutSemicolon}) WHERE ROWNUM <= ${maxRows}`;
  }

  private replacePositionalParameters(sql: string, parameters: any[]): { sql: string; bindValues: any[] } {
    if (!parameters.length) {
      return { sql, bindValues: [] };
    }

    let index = 0;
    let result = "";
    let i = 0;
    while (i < sql.length) {
      const char = sql[i];
      const next = sql[i + 1];

      if (char === "'") {
        const start = i++;
        while (i < sql.length) {
          if (sql[i] === "'" && sql[i + 1] === "'") {
            i += 2;
          } else if (sql[i] === "'") {
            i++;
            break;
          } else {
            i++;
          }
        }
        result += sql.slice(start, i);
        continue;
      }

      if (char === '"' ) {
        const start = i++;
        while (i < sql.length) {
          if (sql[i] === '"' && sql[i + 1] === '"') {
            i += 2;
          } else if (sql[i] === '"') {
            i++;
            break;
          } else {
            i++;
          }
        }
        result += sql.slice(start, i);
        continue;
      }

      if (char === "-" && next === "-") {
        const start = i;
        i += 2;
        while (i < sql.length && sql[i] !== "\n") {
          i++;
        }
        result += sql.slice(start, i);
        continue;
      }

      if (char === "/" && next === "*") {
        const start = i;
        i += 2;
        while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
          i++;
        }
        i = i < sql.length ? i + 2 : i;
        result += sql.slice(start, i);
        continue;
      }

      if (char === "?") {
        index += 1;
        result += `:${index}`;
        i++;
        continue;
      }

      result += char;
      i++;
    }

    if (index !== parameters.length) {
      throw new Error(
        `Parameter count mismatch: SQL statement has ${index} parameter(s), but ${parameters.length} value(s) were provided.`
      );
    }

    return { sql: result, bindValues: parameters };
  }
}

const damengConnector = new DamengConnector();
ConnectorRegistry.register(damengConnector);
