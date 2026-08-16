# dsh-run-guard

DeepSeek Harness (dsh) 插件:**Agent 运行节奏守护**——刹车 + 油门两个能力合一,保证 LLM 在长任务中既不会"推理死循环停不下来",也不会"想完就停不干活"。

## 功能

| 能力 | 方向 | 说明 |
|------|------|------|
| **guard(刹车)** | 拦截死循环 | 监听 `llm/stream`,对 reasoning 流做滑动窗口重复率检测 + 硬性上限,检测到死循环时中断流并给出中文原因提示(`REASONING_GUARD` 错误) |
| **continue(油门)** | 防止停摆 | turn 正常结束后自动继续:有未完成 todo 时注入 todo 状态并续跑(有计数上限);无 todo 但"想完就停"(最后一条消息只有推理)时注入简洁提示续跑(无上限) |

模型可随时调用 `pause_work` 工具主动暂停,两路都不会再自动继续。

## 安装

### 发布版(GitHub 安装,推荐)

```bash
dsh plugin --profile web add "github:Dis2017/dsh-run-guard#v0.1.2"
```

`dsh plugin add` 检测到 `dsh.bundle` 声明后自动挂载(追加进 profile 的 bundles 列表),插件行由 bundle patch 提供。

### 开发模式(绝对路径挂载,改代码即时生效)

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: run-guard
      name: /绝对/路径/dsh-run-guard/lib/index.js?v=1
```

### 依赖约定(重要)

`@deepseek-ai/*` 全部声明在 **peerDependencies**(由 dsh 主程序提供单例)——绝不能放进 `dependencies`,否则 pnpm(hoisted)会把它提升到 profile 顶层 node_modules,形成第二份实例,破坏 DSH 的 Symbol 单例(`TOOL_RUNTIME_SCHEDULER`),导致 `Cannot read properties of undefined (reading 'prepare')`。业务依赖(裸 `schemastery` 等)放 `dependencies`;测试用的 dsh 依赖放 `devDependencies`(不随安装)。

## 配置

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `enabled` | `true` | 总开关 |
| `guard.enabled` | `true` | 死循环拦截开关 |
| `guard.windowChars` | `2000` | 滑动窗口大小(字符) |
| `guard.substrLen` | `32` | 重复检测子串长度 |
| `guard.repeatRatio` | `0.7` | 窗口重复率阈值(≥ 触发) |
| `guard.checkEvery` | `50` | 每 N 块检测一次 |
| `guard.maxBlocks` | `10000` | 硬闸:单次调用推理块数上限 |
| `guard.maxChars` | `500000` | 硬闸:单次调用推理字符数上限 |
| `continue.enabled` | `true` | 自动继续开关 |
| `continue.maxAutoFollowups` | `3` | 有 todo 场景连续无产出继续上限 |

## 测试

```bash
pnpm install
pnpm test   # 54 个单测(guard 检测器 / 流拦截 / continue / 合并入口 / 两 half 集成)
```

## 已知边界

- guard 中断的 turn 以 error 结束(不静默重试),continue 不会误推
- 无 todo + 持续"想完就停"会无上限续跑,可调用 `pause_work` 暂停
- 空 turn(无任何消息)不视为"想完就停"
