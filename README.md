# DBHub Dameng

让 AI 直接连接达梦 DM8，查询数据、查看表结构和字段说明。
基于 [Bytebase DBHub](https://github.com/bytebase/dbhub)，增加最小达梦适配。
使用已发布的 npm 包即可，无需克隆仓库或编译源码。

默认只有两个 MCP 工具：

| 工具 | 用途 |
| --- | --- |
| `search_objects` | 查找 schema、表、视图、字段、索引和存储过程 |
| `execute_sql` | 执行 SQL；按下方配置只允许读取，最多返回 100 行 |

## 最简单：把这份 README 和连接串交给 AI

在能够读写本机项目文件的 AI 编程客户端中，发送下面这段话。
将最后一行替换为自己的连接串；也可以提供已有本地连接配置文件的路径。

```text
请根据以下 README，直接帮我在当前项目配置 DBHub 达梦 MCP，并验证连接：
https://github.com/zuozh11/dbhub-dameng/blob/main/README.md

要求：
1. 检查 Node.js >= 22.5，以及 npm/npx 是否可用。
2. 使用 @zz1996/dbhub-dameng@latest，以 stdio 启动。
3. 创建本机专用的 .agents/dbhub.dameng.toml，开启 readonly = true、max_rows = 100，
   只启用 execute_sql 和 search_objects。不要执行初始化脚本。
4. 将含真实连接串的文件排除出 Git；如果同名文件已被跟踪，改用仓库外的本地文件。
   不要把密码写进 README、提交记录或最终回复。
5. 检查当前客户端已有的 MCP 配置，只新增或更新 DBHub 条目，保留其他配置。
   --config 使用配置文件的绝对路径。能识别客户端就直接配置，无法识别时再问我。
6. 重连 MCP，确认两个工具可用，执行 SELECT 1 AS OK FROM DUAL，
   再用 search_objects 查询当前 schema 下的一个表名；不要读取业务数据或执行写操作。
   如果无法控制客户端重连，请明确告诉我需要在哪一步重连，不要把文件写好当成连接成功。
7. 完成后说明配置文件位置、验证结果，以及是否还需要我重启客户端。

我的数据库连接串：dameng://user:password@host:5236/APP
```

如果只使用普通聊天网页，AI 可以生成配置，但需要你自己保存到本机并在 MCP 客户端中启用。
真实连接信息仅提供给你信任的客户端；共享或生产库请使用最小权限只读账号。

## 连接串怎么写

```text
dameng://用户名:密码@主机:5236/Schema名称
```

例如下面是虚构的配置：

```text
dameng://reader:example_password@127.0.0.1:5236/APP
```

- 默认端口为 `5236`。
- 路径中的 `APP` 是 schema，不是数据库实例名；按数据库中的实际大小写填写。
- 用户名、密码中的特殊字符要进行 URL 编码，例如 `@` → `%40`、`#` → `%23`、`/` → `%2F`。
  已编码的连接串不要重复编码。
- 启动 MCP 的电脑必须能够访问该地址；内网数据库可能需要先连接 VPN。

## 手动配置

### 1. 准备 Node.js

需要 Node.js **>= 22.5**，并能访问 npm registry：

```sh
node --version
npm --version
npx --version
```

### 2. 创建本机数据库配置

创建 `.agents/dbhub.dameng.toml`，替换下面的示例连接串：

```toml
[[sources]]
id = "default"
dsn = "dameng://reader:example_password@127.0.0.1:5236/APP"

[[tools]]
name = "execute_sql"
source = "default"
readonly = true
max_rows = 100

[[tools]]
name = "search_objects"
source = "default"
```

将 `/.agents/dbhub.dameng.toml` 加入项目的 `.gitignore`，确保该文件未被 Git 跟踪。
已被跟踪的文件不会因加入 `.gitignore` 自动停止跟踪，此时请改用仓库外的本地配置文件。

也可以使用 `dsn = "${DAMENG_DSN}"`，由客户端向 MCP 进程传入环境变量。
不要假设从桌面打开的客户端会继承终端里临时 `export` 的变量。

### 3. 添加到 MCP 客户端

以下示例中的 `/absolute/path/to/project/.agents/dbhub.dameng.toml`
必须替换为上一步文件的**绝对路径**。已有配置请合并，不要覆盖整个文件。

**使用 `mcpServers` JSON 格式的客户端：**

将下面条目合并到客户端的 MCP 配置中；不同客户端的配置文件位置由客户端决定。

```json
{
  "mcpServers": {
    "dbhub": {
      "command": "npx",
      "args": [
        "--yes",
        "@zz1996/dbhub-dameng@latest",
        "--transport", "stdio",
        "--config", "/absolute/path/to/project/.agents/dbhub.dameng.toml"
      ]
    }
  }
}
```

**Codex：**

将下面内容合并到项目的 `.codex/config.toml`（项目需受信任），
或用户级的 `~/.codex/config.toml`：

```toml
[mcp_servers.dbhub]
command = "npx"
args = ["--yes", "@zz1996/dbhub-dameng@latest", "--transport", "stdio", "--config", "/absolute/path/to/project/.agents/dbhub.dameng.toml"]
```

配置位置和字段可参考 [Codex 官方 MCP 文档](https://developers.openai.com/zh-Hans/docs/extend/mcp)。
Windows 上若客户端无法直接启动 `npx`，可将 `command` 改为 `npx.cmd`；
TOML/JSON 中的 Windows 路径可以使用正斜杠，例如 `C:/projects/app/.agents/dbhub.dameng.toml`。

### 4. 重连并验证

在客户端重新连接 MCP，必要时重启客户端。第一次启动需要下载 npm 包。
让 AI 执行：

```text
请用 execute_sql 执行 SELECT 1 AS OK FROM DUAL，
再用 search_objects 查看当前 schema 的一个表名（object_type=table、detail_level=names、limit=1）。
```

看到 SQL 返回 `OK = 1`，且对象查询没有连接错误，即完成基本连通性验证。
schema 中没有可见表时可以返回空列表。检索字段或索引时，应同时提供 `schema` 和 `table`。

终端排查启动问题时，也可以直接运行：

```sh
npx --yes @zz1996/dbhub-dameng@latest --transport stdio --config /absolute/path/to/project/.agents/dbhub.dameng.toml
```

stdio 模式启动后等待 MCP 客户端请求是正常行为，这不是 SQL 交互终端；单纯启动不代表数据库查询已验证。

## 更新与边界

- 使用 `@latest` 的配置在重新启动 MCP 时获取当前版本；已经运行的进程不会热更新。
- 需要固定版本时，将 `@latest` 换成明确的 npm 版本号。
- 只读模式不能替代数据库权限，尤其不能隔离数据库函数内部的副作用。
- 支持普通 SQL、表/视图/字段/索引元数据，以及独立存储过程和函数的参数、返回类型与源码。
- 支持包含内部分号的 PL/SQL 块；只读工具仍会拒绝执行块。写入模式沿用逐条自动提交，
  多语句不是原子事务。自定义工具继续使用 `?` 占位符，绑定参数仅支持单语句。
- `explain_sql` 和 `health_check` 可选启用，默认工具仍为两个。

### 可选：执行计划和健康检查

在现有 TOML 配置中追加（`source` 与对应数据源的 `id` 一致）：

```toml
[[tools]]
name = "explain_sql"
source = "default"

[[tools]]
name = "health_check"
source = "default"
```

`explain_sql` 返回达梦原生执行计划，只接受单条 `SELECT` / `WITH`，不会执行目标查询；
不支持 `ANALYZE`、绑定参数或保存命名计划。
`health_check` 返回会话数量、连接上限和缓存命中指标；无权访问相关系统视图时，
对应部分省略并附说明。当前不提供会话持续时间，这些字段为 `null`。
无需为使用默认工具额外开放系统视图权限。

[npm 包](https://www.npmjs.com/package/@zz1996/dbhub-dameng) ·
[开发与自动发布说明](https://github.com/zuozh11/dbhub-dameng/blob/main/DAMENG.md) ·
[上游 DBHub](https://github.com/bytebase/dbhub)

本项目沿用上游 MIT 许可证，详见 [LICENSE](https://github.com/zuozh11/dbhub-dameng/blob/main/LICENSE)。
