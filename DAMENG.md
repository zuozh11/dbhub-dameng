# DBHub：最小达梦适配

基于 [Bytebase DBHub](https://github.com/bytebase/dbhub) 的薄层 fork。
默认仍只有 `search_objects` 和 `execute_sql`，保留上游搜索流程和结果格式。

## 使用

安装、客户端配置，以及可直接交给 AI 的配置提示词，请阅读
[README](https://github.com/zuozh11/dbhub-dameng/blob/main/README.md)。
GitHub 首页与 npm 包使用同一份 README。

## 实现范围

- 复用上游两个默认工具及搜索流程；不增加连接重试、超时重建或搜索加速。
- `dmdb` 提供原生连接池、参数绑定与行数限制。
- `connection_timeout`、`query_timeout` 分别传给驱动的 `connectTimeout`、`sessionTimeout`。
- 自定义工具使用 `?` 占位符，参数仅支持单语句。
- 初始化脚本只在启动时执行；每条连接的 schema 应通过 DSN 指定。
- Oracle 与达梦共享 `OracleCatalog` 元数据查询及 PL/SQL 分句器；连接池、超时、
  结果处理和诊断 SQL 仍由各自驱动负责。达梦对象名保持原样，Oracle 保留原有大小写折叠。
- 支持 PL/SQL 块，但只读工具拒绝执行块；写入仍逐条自动提交，不承诺批次原子性。
- 可选 `explain_sql` 使用 `EXPLAIN FOR` 返回计划，只允许单条读查询；
  `dmdb` 在此路径不接受绑定参数，因此明确拒绝而不插值拼接参数。
- 可选 `health_check` 查询 `V$SESSIONS`、`V$DM_INI`、`V$BUFFERPOOL`。
  达梦 `N_LOGIC_READS` 是缓存命中次数，命中率按 `hits / (hits + misses)` 计算。
  权限不足的部分返回说明，暂不支持的会话持续时间返回 `null`。
- 对照依据：[达梦执行计划文档](https://eco.dameng.com/document/dm/zh-cn/pm/check-phrases)、
  [动态管理视图](https://eco.dameng.com/document/dm/zh-cn/pm/dynamic-management.html)、
  [缓存命中口径](https://eco.dameng.com/document/dm/zh-cn/pm/dbms_workload-package)。

## 验证

```sh
pnpm install --frozen-lockfile
pnpm test:unit
pnpm build
pnpm test:build
# 可选：明确指定本机配置，只读验证真实 DM8（不会执行 init_script）
node scripts/verify-dameng.mjs /absolute/path/to/dbhub.toml [source-id]
# 另外验证可选诊断工具（不会修改原配置）
node scripts/verify-dameng.mjs /absolute/path/to/dbhub.toml [source-id] --extended
```

GitHub 检查无需真实库凭据；真实 DM8 验证在本机显式运行。

## 自动同步和发布

`.github/workflows/dameng-sync-publish.yml` 每天北京时间 10:23 执行，
也会在 `main` 更新时执行，支持手动运行。

1. 将最新 `bytebase/dbhub:main` 合并到临时工作区。
2. 安装锁定依赖，运行单测、完整构建与打包导入检查。
3. 全部通过后才将合并提交推送到本仓库 `main`，不强推。
4. 准备发布目录，使用 npm OIDC 发布 `@zz1996/dbhub-dameng`。

冲突、测试或构建失败时停止，不更新远端 `main`，通过 GitHub Actions 失败状态定位问题。
发布失败时保留已验证的合并结果，可重新运行；已发布版本会跳过。
原生邮件通知取决于个人 Actions 设置和运行触发者，机器人触发的发布不保证通知仓库所有者。
机器人推送不会触发新的 workflow；产生合并提交后显式再次触发本工作流，
由新提交对应的运行发布，确保 npm provenance 指向实际构建的提交。
这是检查后直接合并的最小流程，不创建自动审批 PR，也不需要长期 PAT。

源码的 `package.json` 版本号、包名和上游发布工作流保持原样。
README 按本 fork 的使用方式维护，上游修改同一段时可能需要手动合并。
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
