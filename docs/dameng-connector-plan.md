# Dameng/DM8 Connector Plan

This fork tracks the work needed to add Dameng/DM8 support to DBHub without
changing DBHub's MCP surface area. The desired result is that agents can keep
using `search_objects` and `execute_sql`, while Dameng behaves like the existing
PostgreSQL/MySQL/SQL Server/SQLite connectors.

## Current Baseline

- Upstream repository: `https://github.com/bytebase/dbhub.git`
- Local branch: `dameng-connector`
- Upstream connector types currently include PostgreSQL, MySQL, MariaDB,
  SQL Server, and SQLite.
- DBHub is MIT licensed, so this fork can be modified and used locally while
  preserving the upstream license notice.

## Implementation Checklist

1. Add `dameng` to connector type definitions.
   - `src/connectors/interface.ts`
   - `src/types/config.ts`
   - `src/api/openapi.yaml`
   - regenerate `src/api/openapi.d.ts`

2. Add DSN support.
   - Accept `dameng://user:password@host:5236/schema`.
   - Map default port `5236`.
   - Update `src/utils/dsn-obfuscate.ts`.

3. Add driver loading.
   - Add optional dependency `dmdb`.
   - Add a lazy loader entry in `src/index.ts`.
   - Keep startup behavior consistent with other optional database drivers.

4. Implement `src/connectors/dameng/index.ts`.
   - `clone`
   - `connect`
   - `disconnect`
   - `getSchemas`
   - `getDefaultSchema`
   - `getTables`
   - `getViews`
   - `getTableSchema`
   - `tableExists`
   - `getTableIndexes`
   - `getStoredProcedures`
   - `getStoredProcedureDetail`
   - `getTableRowCount`
   - `getTableComment`
   - `executeSQL`

5. Add read-only handling.
   - Add Dameng allowed keywords in `src/utils/allowed-keywords.ts`.
   - Add Dameng scanner fallback in `src/utils/sql-parser.ts` if needed.
   - Prefer database account permissions as the primary safety boundary.

6. Add identifier quoting and parameter mapping.
   - `src/utils/identifier-quoter.ts`
   - `src/utils/parameter-mapper.ts`
   - Dameng generally accepts Oracle-style uppercase identifiers and bind
     variables; verify actual `dmdb` binding shape before finalizing.

7. Add docs and examples.
   - `dbhub.dameng.toml.example`
   - README support list
   - docs installation/configuration references if this fork is published.

8. Add tests.
   - Unit tests for DSN parsing and readonly SQL classification.
   - Connector tests against a reachable DM8 instance when available.
   - Build smoke test before using the MCP server in an agent.

## Useful Catalog Queries

List schemas:

```sql
SELECT USERNAME AS SCHEMA_NAME
FROM ALL_USERS
WHERE USERNAME NOT IN ('SYS', 'SYSTEM', 'SYSAUDITOR', 'SYSSSO', 'CTISYS')
ORDER BY USERNAME;
```

List tables:

```sql
SELECT TABLE_NAME
FROM ALL_TABLES
WHERE OWNER = :owner
ORDER BY TABLE_NAME;
```

List columns:

```sql
SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, DATA_PRECISION, DATA_SCALE,
       NULLABLE, DATA_DEFAULT, COLUMN_ID
FROM ALL_TAB_COLUMNS
WHERE OWNER = :owner AND TABLE_NAME = :table
ORDER BY COLUMN_ID;
```

List indexes:

```sql
SELECT i.INDEX_NAME, i.UNIQUENESS, ic.COLUMN_NAME, ic.COLUMN_POSITION
FROM ALL_INDEXES i
JOIN ALL_IND_COLUMNS ic
  ON i.OWNER = ic.INDEX_OWNER AND i.INDEX_NAME = ic.INDEX_NAME
WHERE i.TABLE_OWNER = :owner AND i.TABLE_NAME = :table
ORDER BY i.INDEX_NAME, ic.COLUMN_POSITION;
```

Table comments:

```sql
SELECT COMMENTS
FROM ALL_TAB_COMMENTS
WHERE OWNER = :owner AND TABLE_NAME = :table;
```

Column comments:

```sql
SELECT COLUMN_NAME, COMMENTS
FROM ALL_COL_COMMENTS
WHERE OWNER = :owner AND TABLE_NAME = :table;
```

## Suggested First Milestone

Build the minimum useful connector first:

- DSN parser
- `connect` / `disconnect`
- `executeSQL`
- `getSchemas`
- `getTables`
- `getTableSchema`
- readonly keyword support

After that, wire the connector into `search_objects` and test agent behavior
with `detail_level: "names"` before adding richer metadata.
