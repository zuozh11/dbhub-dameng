import fs from "fs";
import toml from "@iarna/toml";
import { describe, expect, it } from "vitest";
import { DamengConnector } from "../dameng/index.js";
import { buildDSNFromSource, interpolateEnvVars } from "../../config/toml-loader.js";
import type { SourceConfig } from "../../types/config.js";

const DEFAULT_REAL_CONFIG =
  "/Users/zuozhi/workspace/Lanyou/QX_SRM/df-mdf-prd-productive/.agents/dbhub.dameng.toml";

function resolveRealConfigPath(): string | null {
  const configPath = process.env.DAMENG_TEST_CONFIG || DEFAULT_REAL_CONFIG;
  return fs.existsSync(configPath) ? configPath : null;
}

function loadRealDamengSource(configPath: string): SourceConfig {
  const parsed = interpolateEnvVars(
    toml.parse(fs.readFileSync(configPath, "utf8"))
  ) as { sources?: SourceConfig[] };
  const sourceId = process.env.DAMENG_TEST_SOURCE;
  const source = sourceId
    ? parsed.sources?.find((item) => item.id === sourceId)
    : parsed.sources?.find(
        (item) =>
          item.type === "dameng" ||
          item.dsn?.startsWith("dameng://") ||
          item.dsn?.startsWith("dm://")
      );

  if (!source) {
    throw new Error(`No Dameng source found in ${configPath}`);
  }
  return source;
}

const realConfigPath = resolveRealConfigPath();
const describeRealDameng = realConfigPath ? describe : describe.skip;

describeRealDameng("Dameng connector real database integration", () => {
  it("connects, executes SQL, discovers metadata, and reconnects with the same pool alias", async () => {
    const source = loadRealDamengSource(realConfigPath!);
    const dsn = buildDSNFromSource(source);

    const connector = new DamengConnector();
    (connector as any).sourceId = source.id;
    await connector.connect(dsn, source.init_script, {
      connectionTimeoutSeconds: source.connection_timeout,
      queryTimeoutSeconds: source.query_timeout,
    });

    try {
      const result = await connector.executeSQL("SELECT 1 AS CONNECTION_TEST FROM DUAL", {});
      expect(result.rows.length).toBeGreaterThan(0);

      const schemas = await connector.getSchemas();
      expect(schemas.length).toBeGreaterThan(0);

      const defaultSchema = await connector.getDefaultSchema();
      expect(defaultSchema).toBeTruthy();

      const tables = await connector.getTables(defaultSchema || undefined);
      expect(tables.length).toBeGreaterThan(0);
    } finally {
      await connector.disconnect();
    }

    const reconnectingConnector = new DamengConnector();
    (reconnectingConnector as any).sourceId = source.id;
    await reconnectingConnector.connect(dsn, source.init_script, {
      connectionTimeoutSeconds: source.connection_timeout,
      queryTimeoutSeconds: source.query_timeout,
    });

    try {
      const result = await reconnectingConnector.executeSQL("SELECT 1 AS CONNECTION_TEST FROM DUAL", {});
      expect(result.rows.length).toBeGreaterThan(0);
    } finally {
      await reconnectingConnector.disconnect();
    }
  }, 60000);
});
