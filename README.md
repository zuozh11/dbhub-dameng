> [!NOTE]  
> Brought to you by [Bytebase](https://www.bytebase.com/), open-source database DevSecOps platform.

> [!NOTE]
> This package is a local Dameng/DM8 connector fork of Bytebase DBHub. Use
> `npx -y @zz1996/dbhub-dameng --transport stdio --config ./dbhub.dameng.toml`
> for Dameng MCP usage.
>
> Dameng DSN format: `dameng://user:password@host:5236/schema`. Prefer a
> least-privilege read-only Dameng account for production or shared databases,
> even when the `execute_sql` tool is configured with `readonly = true`.

<p align="center">
<a href="https://dbhub.ai/" target="_blank">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/bytebase/dbhub/main/docs/images/logo/full-dark.svg" width="75%">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/bytebase/dbhub/main/docs/images/logo/full-light.svg" width="75%">
  <img src="https://raw.githubusercontent.com/bytebase/dbhub/main/docs/images/logo/full-light.svg" width="75%" alt="DBHub Logo">
</picture>
</a>
</p>

```bash
            +------------------+    +--------------+    +------------------+
            |                  |    |              |    |                  |
            |                  |    |              |    |                  |
            |  Claude Desktop  +--->+              +--->+    PostgreSQL    |
            |                  |    |              |    |                  |
            |  Claude Code     +--->+              +--->+    SQL Server    |
            |                  |    |              |    |                  |
            |  Cursor          +--->+    DBHub     +--->+    SQLite        |
            |                  |    |              |    |                  |
            |  VS Code         +--->+              +--->+    MySQL         |
            |                  |    |              |    |                  |
            |  Copilot CLI     +--->+              +--->+    MariaDB       |
            |                  |    |              |    |                  |
            |                  +--->+              +--->+    Dameng / DM8  |
            |                  |    |              |    |                  |
            +------------------+    +--------------+    +------------------+
                 MCP Clients           MCP Server             Databases
```

DBHub is a zero-dependency, token efficient MCP server implementing the Model Context Protocol (MCP) server interface. This lightweight gateway allows MCP-compatible clients to connect to and explore different databases:

- **Local Development First**: Zero dependency, token efficient with just two MCP tools to maximize context window
- **Multi-Database**: PostgreSQL, MySQL, MariaDB, SQL Server, SQLite, and Dameng/DM8 through a single interface
- **Multi-Connection**: Connect to multiple databases simultaneously with TOML configuration
- **Guardrails**: Read-only mode, row limiting, and query timeout to prevent runaway operations
- **Secure Access**: SSH tunneling and SSL/TLS encryption

## Supported Databases

PostgreSQL, MySQL, SQL Server, MariaDB, SQLite, and Dameng/DM8.

## MCP Tools

DBHub implements MCP tools for database operations:

- **[execute_sql](https://dbhub.ai/tools/execute-sql)**: Execute SQL queries with transaction support and safety controls
- **[search_objects](https://dbhub.ai/tools/search-objects)**: Search and explore database schemas, tables, columns, indexes, and procedures with progressive disclosure
- **[Custom Tools](https://dbhub.ai/tools/custom-tools)**: Define reusable, parameterized SQL operations in your `dbhub.toml` configuration file

## Workbench

DBHub includes a [built-in web interface](https://dbhub.ai/workbench/overview) for interacting with your database tools. It provides a visual way to execute queries, run custom tools, and view request traces without requiring an MCP client.

![workbench](https://raw.githubusercontent.com/bytebase/dbhub/main/docs/images/workbench/workbench.webp)

## Installation

See the full [Installation Guide](https://dbhub.ai/installation) for detailed instructions.

### Quick Start

**Docker:**

```bash
docker run --rm --init \
   --name dbhub \
   --publish 8080:8080 \
   bytebase/dbhub \
   --transport http \
   --port 8080 \
   --dsn "postgres://user:password@localhost:5432/dbname?sslmode=disable"
```

**NPM:** (requires Node.js >= 22.5.0)

```bash
npx @bytebase/dbhub@latest --transport http --port 8080 --dsn "postgres://user:password@localhost:5432/dbname?sslmode=disable"
```

**Dameng / DM8 fork:**

```bash
npx -y @zz1996/dbhub-dameng --transport stdio --config ./dbhub.dameng.toml
```

Minimal Dameng TOML configuration:

```toml
[[sources]]
id = "dm8_readonly"
description = "Dameng DM8 database for schema discovery and read-only SQL queries"
dsn = "dameng://${DM8_USER}:${DM8_PASSWORD}@${DM8_HOST}:5236/${DM8_SCHEMA}"
query_timeout = 30
lazy = true

[[tools]]
name = "search_objects"
source = "dm8_readonly"

[[tools]]
name = "execute_sql"
source = "dm8_readonly"
readonly = true
max_rows = 100
```

To verify the local Dameng connector against a real DM8 instance without
committing credentials, set `DAMENG_DSN` or point to a local TOML file:

```bash
DAMENG_DSN="dameng://user:password@host:5236/schema" pnpm verify:dameng
pnpm verify:dameng -- --config ./dbhub.dameng.toml --source dm8_readonly
```

**Demo Mode:**

```bash
npx @bytebase/dbhub@latest --transport http --port 8080 --demo
```

**Restrict to loopback (recommended for production):**

```bash
npx @bytebase/dbhub@latest --transport http --host 127.0.0.1 --port 8080 --demo
```

> The HTTP transport defaults to `--host 0.0.0.0`, exposing DBHub on every network interface. For production, bind to `127.0.0.1` and front DBHub with a reverse proxy (nginx/Caddy) or firewall — DBHub does not authenticate HTTP clients.
>
> The HTTP transport also has built-in DNS-rebinding protection: it only accepts requests whose `Host` is loopback, this machine's own hostname/IPs, or a name you allow via [`--allowed-hosts`](https://dbhub.ai/config/command-line#allowed-hosts). If a client behind a reverse proxy or custom DNS name gets a `403`, add that hostname with `--allowed-hosts`.

See [Command-Line Options](https://dbhub.ai/config/command-line) for all available parameters.

### Multi-Database Setup

Connect to multiple databases simultaneously using TOML configuration files. Perfect for managing production, staging, and development databases from a single DBHub instance.

See [Multi-Database Configuration](https://dbhub.ai/config/toml) for complete setup instructions.

## Development

Requires Node.js >= 22.5.0 (DBHub uses the built-in `node:sqlite` module).

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm dev

# Build and run for production
pnpm build && pnpm start --transport stdio --dsn "postgres://user:password@localhost:5432/dbname"
```

See [Testing](.claude/skills/testing/SKILL.md) and [Debug](https://dbhub.ai/config/debug).

## Contributors

<a href="https://github.com/bytebase/dbhub/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=bytebase/dbhub" />
</a>

## Star History

<a href="https://www.star-history.com/?repos=bytebase%2Fdbhub&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=bytebase/dbhub&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=bytebase/dbhub&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=bytebase/dbhub&type=date&legend=top-left" />
 </picture>
</a>
