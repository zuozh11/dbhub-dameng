## Project Goal

This repository is a local fork of Bytebase DBHub for adding Dameng/DM8 database
support while preserving DBHub's token-efficient MCP design.

## Local Rules

- Always reply to the user in Simplified Chinese.
- Keep DBHub's existing two-tool interaction model intact:
  `search_objects` for progressive schema discovery and `execute_sql` for SQL
  execution.
- Prefer a connector-level implementation over adding Dameng-only tools.
- Preserve upstream compatibility where possible so this fork can rebase on
  Bytebase DBHub.
- Do not put real database credentials in committed config files.
- For production or shared databases, assume a least-privilege read-only Dameng
  account is required even if DBHub readonly mode is enabled.

## Dameng Connector Notes

- Target DSN shape: `dameng://user:password@host:5236/schema`.
- Candidate Node driver: `dmdb`.
- Metadata discovery should use Dameng/Oracle-style catalog views such as
  `ALL_USERS`, `ALL_TABLES`, `ALL_VIEWS`, `ALL_TAB_COLUMNS`,
  `ALL_INDEXES`, `ALL_IND_COLUMNS`, `ALL_TAB_COMMENTS`, and
  `ALL_COL_COMMENTS`.
- Keep output compact and compatible with existing DBHub types:
  `TableColumn`, `TableIndex`, `StoredProcedure`, and `SQLResult`.
