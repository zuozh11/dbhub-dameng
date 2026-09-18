# DBHub：最小达梦适配

基于 [Bytebase DBHub](https://github.com/bytebase/dbhub) 的薄层 fork。
默认仍只有 `search_objects` 和 `execute_sql`，保留上游搜索流程和结果格式。

## 使用

Node.js >= 22.5。将 `dbhub.dameng.toml.example` 复制为本地 `dbhub.toml`，
通过环境变量 `DAMENG_DSN` 提供连接串：

```text
dameng://user:password@host:5236/APP
```

账号、密码中的特殊字符需要 URL 编码。路径是 schema，名称与数据库保持一致，
包括大小写。使用最小权限只读账号连接共享或生产库。

```sh
npx @zz1996/dbhub-dameng@latest --transport stdio --config ./dbhub.toml
```

- 驱动为固定版本 `dmdb`，采用原生连接池、参数绑定和行数限制。
- 不增加连接重试、超时重建、后台恢复或元数据搜索加速。
- `connection_timeout`、`query_timeout` 分别传给驱动的 `connectTimeout`、`sessionTimeout`。
- SQL 结果按语句返回，超过 `max_rows` 时附带 `truncated`。
- 自定义工具使用 `?` 占位符；参数仅支持单语句。
- 只读判断复用上游策略，不能代替数据库账号权限；函数副作用不由连接器保证隔离。
- 本实验覆盖普通 SQL 查询和元数据浏览；不提供达梦 `explain_sql`、`health_check`，
  不支持包含内部分号的匿名 PL/SQL 块。初始化脚本按上游惯例在启动时执行，
  不应依赖它设置连接池每条连接的会话状态，schema 应在 DSN 中指定。

## 验证

```sh
pnpm install --frozen-lockfile
pnpm test:unit
pnpm build
pnpm test:build
# 可选：明确指定本机配置，只读验证真实 DM8（不会执行 init_script）
node scripts/verify-dameng.mjs /absolute/path/to/dbhub.toml [source-id]
```

GitHub 检查无需真实库凭据；真实 DM8 验证在本机显式运行。

## 自动同步和发布

`.github/workflows/dameng-sync-publish.yml` 每天北京时间 10:23 执行，
也会在 `main` 更新时执行，支持手动运行。

1. 将最新 `bytebase/dbhub:main` 合并到临时工作区。
2. 安装锁定依赖，运行单测、完整构建与打包导入检查。
3. 全部通过后才将合并提交推送到本仓库 `main`，不强推。
4. 准备发布目录，使用 npm OIDC 发布 `@zz1996/dbhub-dameng`。

冲突、测试或构建失败时停止，不更新远端 `main`，通过 GitHub Actions 失败通知处理。
发布失败时保留已验证的合并结果，可重新运行；已发布版本会跳过。
机器人推送不会触发新的 workflow；产生合并提交后显式再次触发本工作流，
由新提交对应的运行发布，确保 npm provenance 指向实际构建的提交。
这是检查后直接合并的最小流程，不创建自动审批 PR，也不需要长期 PAT。

源码的 `package.json` 版本号、包名、上游 README 和上游发布工作流保持原样。
仅打包时设置 fork 身份，版本为 `<上游版本>-dameng.<提交总数>`，发布到 `latest` 标签。
例如 `1.2.5-dameng.620`；它是独立 fork 版本，不是 Bytebase 官方发行版。
每次代码合并都会得到新版本，同一提交重跑使用同一个版本号。

首次配置：

- 在本仓库 Actions 设置中禁用继承的 `npm-publish.yml`、`docker-publish.yml`、
  `mcpb-release.yml`，避免执行 Bytebase 的发布流程；保持文件原样以降低同步冲突。
- 在 npm 包设置中添加 GitHub Actions Trusted Publisher：用户 `zuozh11`，
  仓库 `dbhub-dameng`，工作流 `dameng-sync-publish.yml`，环境名留空，允许 `npm publish`。
- workflow 显式申请 `contents: write`、`actions: write` 和 `id-token: write`；无需 npm token。
- 手动运行时可取消 `publish`，只验证同步和打包。

旧实现保留在 `dameng-connector` 分支中；新实现不继承其恢复机制。
