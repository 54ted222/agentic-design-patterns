# 從零重建 AI Agent 平台 — LibreChat 架構解析

> 針對 **LibreChat** 原始碼的深度架構解析(共 19 篇 + 總覽)
> 目標讀者:要用 PostgreSQL + Hono + Next.js + pnpm + Redis + docker-compose **從零重建 AI agent 平台**的工程師
> 繁體中文(zh-TW)
>
> 每份文件回答三個問題:它怎麼運作、為什麼這樣設計、移植到新技術棧時該怎麼取捨。

## 目錄

- [總覽與導讀](01-overview.md)

### 平台骨架與核心生成鏈

1. [整體架構總覽](01-architecture-overview.md)
2. [設定系統](02-config-system.md)
3. [Agent 資料模型](03-agent-data-model.md)
4. [執行引擎](04-execution-engine.md)
5. [多代理協作](05-multi-agent.md)
6. [LLM Provider 抽象層](06-llm-providers.md)

### 工具生態

7. [工具系統](07-tool-system.md)
8. [MCP 整合](08-mcp-integration.md)
9. [Actions(OpenAPI 工具)](09-actions-openapi.md)
10. [File Search / RAG](10-file-search-rag.md)
11. [Code Interpreter 沙箱](11-code-interpreter.md)
12. [記憶系統](12-memory-system.md)
13. [檔案與多模態](13-files-multimodal.md)

### 串流、對話與平台營運

14. [串流與可恢復性](14-streaming-resumability.md)
15. [對話與訊息模型](15-conversations-messages.md)
16. [權限與共享](16-permissions-sharing.md)
17. [認證與安全](17-auth-security.md)
18. [快取與 Redis](18-caching-redis.md)

### 框架選型

19. [AI 框架選型對照](19-framework-options.md)
