# coding-agent 已实施改进记录

> 本文档记录 [架构分析](./coding-agent-architecture-review.md) 中各优先级建议的实施详情。

---

## P0-#1：Tool 并行执行（`sideEffects` 分组）— 已实施

- `packages/agent/src/types.ts`：`AgentTool` 接口新增 `sideEffects?: boolean`（默认 `true`，保守语义）
- `packages/agent/src/agent-loop.ts`：重写 `executeToolCalls`，新增辅助函数：
  - `groupToolCallBatches()` — 将连续 `sideEffects: false` 的 tool call 分组为并行 batch
  - `executeSingleToolCall()` — 提取单个 tool 执行逻辑
  - `executeToolCallBatchParallel()` — 通过 `Promise.all` 并行执行 batch
  - `createToolResultMessage()` — 构造 ToolResultMessage 辅助函数
  - steering 检查在每个 serial tool 后和每个 parallel batch 完成后统一执行
- `packages/coding-agent/src/core/tools/{read,grep,find,ls}.ts`：标记 `sideEffects: false`
- 有副作用的工具（`edit`、`write`、`bash`）保持默认 `true`

## P0-#13：Agent 状态自省注入 — 已实施

- `packages/coding-agent/src/core/sdk.ts`：增强 `transformContext` 回调
  - 当上下文使用率 ≥ 50% 时，注入 `customType: "systemState"` 消息
  - 格式：`[Context: Xk/Yk tokens (Z%). Compaction at Wk.]`
  - 可选附加最新 compaction entry 的文件追踪信息（Modified/Read files）
  - `display: false` — 用户不可见，仅 LLM 可感知
  - 由 `convertToLlm` 转为 `user` 角色消息，追加在上下文末尾
  - 不持久化到 session 文件

## P0-#7：Compaction 降级路径 — 已实施

- `packages/coding-agent/src/core/compaction/compaction.ts`：新增 `compactFallback()` 函数
  - 规则级摘要：提取 user message 前 200 字符、tool call 列表、文件操作记录
  - 不调用 LLM，纯基于已有数据生成 `CompactionResult`
- `packages/coding-agent/src/core/agent-session.ts`：`_runAutoCompaction` catch 块增强
  - LLM compaction 失败时自动尝试 `compactFallback(preparation)`
  - 降级成功：应用 compaction 结果 + 发出带警告的事件 + 触发重试
  - 降级也失败：回退到原有错误处理流程

---

## P1-#2：transformContext 浅拷贝保护 — 已实施

- `packages/agent/src/agent-loop.ts`：在调用 `transformContext` 前对 `context.messages` 做浅拷贝
  - `let messages = [...context.messages]` 替代直接引用
  - 确保 Extension 的 context transform 无法 mutate 原始 `AgentState`

## P1-#5：Session 延迟写入补丁 — 已实施

- `packages/coding-agent/src/core/session-manager.ts`：`_persist()` 方法增强
  - 用户消息入 state 后立即 flush，不再等到第一条 assistant 消息
  - 修复崩溃时用户消息丢失的数据安全窗口

## P1-#1a：`/tree` 上下文感知增强 — 已实施

- `packages/coding-agent/src/modes/interactive/components/tree-selector.ts`：增强 compaction entry 显示
  - 区分 compaction 类型标签：LLM / fallback / ext（Extension 触发）
  - 文件追踪可视化：显示 Modified(M)、Read(R)、Tool call(T) 计数
  - 格式：`[compaction (LLM): Xk tokens | M:3 R:5 T:12]`

## P1-#8：find/ls 异步化 — 已实施

- `packages/coding-agent/src/core/tools/find.ts`：
  - `spawnSync` → `execFileAsync`（异步子进程）
  - `existsSync` → `access`（异步文件检查）
- `packages/coding-agent/src/core/tools/ls.ts`：
  - `existsSync` → `access`、`statSync` → `stat`、`readdirSync` → `readdir`
  - 全部转为异步 API，不再阻塞事件循环

## P1-#6：结构化 compaction details — 已实施

- `packages/coding-agent/src/core/compaction/compaction.ts`：
  - `CompactionDetails` 接口扩展 `pendingTasks?: string[]` 和 `decisions?: string[]`
  - 新增 `parseSummaryStructure()` — 从 LLM 摘要 markdown 中提取结构化的待办事项和决策记录
- `packages/coding-agent/src/core/sdk.ts`：
  - `transformContext` 自省注入现在包含 `pendingTasks` 和 `decisions`（来自最新 compaction）
- `packages/coding-agent/src/modes/interactive/components/tree-selector.ts`：
  - compaction entry 的 tooltip 中展示结构化 details

## P1-AST：outline 工具（AST 级代码裁剪）— 已实施

- `packages/coding-agent/src/core/tools/outline.ts`：新建文件
  - TS/JS 文件：使用 TypeScript Compiler API（`ts.createSourceFile` + AST 遍历）提取真实符号结构
    - 支持：function、class（含 heritage）、interface、type alias、enum（内联成员）、namespace、method、constructor、getter/setter、arrow function、export const
    - 提取泛型参数、函数签名（参数 + 返回类型）、修饰符（export/async/abstract/static/private 等）
    - 正确的 AST 嵌套深度（class 内 method 自动 depth+1）
    - 不会被字符串/注释中的关键字误匹配
  - 非 TS/JS 语言：regex fallback（Python、Go、Rust、Java、C/C++、Ruby、Shell + 通用 fallback）
  - 工具接口：`sideEffects: false`，支持 `OutlineOperations` 可插拔 I/O
  - 输出格式：`L{行号}: [{kind}] {签名}`，缩进反映嵌套层级
- `packages/coding-agent/src/core/tools/index.ts`：注册到 `readOnlyTools`、`allTools`、`createReadOnlyTools()`、`createAllTools()`
- `packages/coding-agent/test/outline.test.ts`：33 个测试用例
  - 基础语言覆盖：TS、JS、Python、Go、Rust、C/C++、Ruby、Shell、Java（20 例）
  - AST 专项：多行签名、泛型、继承、getter/setter、字符串误匹配、enum 成员、namespace 嵌套、constructor、返回类型、export default、JSX、抽象类、接口方法（13 例）
