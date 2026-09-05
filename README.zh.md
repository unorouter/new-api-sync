[English](README.md) | 中文

> 友情链接：[LINUX DO](https://linux.do/) - 新的理想型社区

# new-api-sync

将上游提供商的定价、渠道和模型同步到你的 [new-api](https://github.com/QuantumNous/new-api) 实例。支持 [new-api](https://github.com/QuantumNous/new-api)、[OpenRouter](https://openrouter.ai/) 以及 [NVIDIA NIM](https://build.nvidia.com/) 上游。

## 快速开始

如果还没有安装 [Bun](https://bun.com/docs/installation)，先安装它。

```bash
bun install
cp config.example.yml config.yml         # 编辑你的配置
bun sync run                             # 运行同步
bun sync run --only myprovider           # 仅同步指定提供商
bun sync run --models "claude-*,gpt-4*"  # 仅同步匹配的模型
bun sync run --verbose                   # 以调试日志级别运行
bun sync reset                           # 删除所有已同步数据
```

## Web 界面

如果你更喜欢点击而不是敲命令，可以启动内置的可视化面板：

```bash
bun ui                          # `bun sync ui` 的简写
bun sync ui --port 4000         # 自定义端口（默认 3000）
```

随后在浏览器打开 `http://localhost:3000`。命令行能做的事，界面里都能做，不用手改 YAML：

- **Dashboard（仪表板）**：实时运行或重置同步流水线。流式日志面板按提供商、模型、价格逐条打印，保留命令行里的彩色输出。可选中要执行的提供商（对应 `--only`），也可以用通配符限定模型（对应 `--models`，例如 `claude-*, gpt-4*`）然后点击 **Start** 启动。模型过滤器按配置记忆：切换配置时会自动恢复上一次的选择。
- **Configuration（配置）**：通过结构化表单编辑所有提供商、目标、黑名单、价格调整、模型映射以及单模型覆盖项。保存前会校验 YAML，失败时自动回滚。
- **多份配置**：在标签旁边的下拉框中创建命名变体（`debug`、`staging`、`prod`）。每份会保存为二进制旁边（开发模式下则是项目根目录下）的 `config.<名称>.yml`，可以切换、复制或删除，不需要直接操作文件系统。跨配置的设置（语言、主题、共享黑名单、共享模型映射）保存在 `config.global.yml`。
- **History（历史）**：浏览过往运行记录（`logs/YYYY-MM-DD-*.json`），包含每个模型的通过或失败结果、费用和真伪校验状态。真伪自动黑名单条目也能在同一标签里管理。
- **主题与语言**：切换深色、浅色、跟随系统三种模式，中英文可一键互换；设置会在会话之间保留。

该界面被打包为各平台的单文件二进制，目标机器无需安装 Bun。`bun run build` 之后可在 `dist/` 中取对应平台的产物（或从发布页下载），直接执行即可：

```bash
./new-api-sync-linux-x64 ui      # Linux
./new-api-sync-darwin-arm64 ui   # macOS（Apple 芯片）
new-api-sync-windows-x64.exe ui  # Windows
```

## 配置

启动时会加载两份文件：

- `config.yml`（或具名变体 `config.<名称>.yml`）：当前激活的同步配置（目标、提供商等）。
- `config.global.yml`（可选）：跨配置共享设置。`locale`、`theme` 以及界面状态都保存于此。这里定义的 `blacklist`、`modelMapping` 与 `groupMapping` 会合并到每份配置中（黑名单做并集去重，映射在键冲突时全局优先）。

### 目标 (target)

| 字段                | 说明                        |
| ------------------- | --------------------------- |
| `baseUrl`           | 你的 new-api 实例地址       |
| `systemAccessToken` | 系统访问令牌（设置 > 其他） |
| `userId`            | 你的用户 ID                 |
| `targetPrefix`      | 可选的同步资源前缀          |

### 全局选项

| 字段                     | 说明                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `testModelTypes`         | 同步时测试的模型类型：`["text", "image", "video", "audio", "embedding"]`（默认：`["text"]`）。提供商级别设置可覆盖全局。 |
| `skipUnprofitableText`   | 跳过有效倍率 >= 1 的文本模型（默认：`true`）。详见下方"行为说明"。                                                       |
| `globalConcurrency`      | 整次运行中同时进行的测试 / 探测 HTTP 请求总数（默认：`50`）。                                                            |
| `perUpstreamConcurrency` | 单个 baseUrl 的默认并发上限（默认：`5`）。可在提供商级别覆盖以适配各上游的限频策略。                                     |
| `blacklist`              | 排除匹配的文本模型（大小写不敏感）。支持 Glob 通配符和提供商作用域模式。详见下方"黑名单"。                               |
| `modelMapping`           | 重命名模型：`{ "claude-sonnet-4-5-20250929-thinking": "claude-sonnet-4-5-20250929" }`                                    |
| `groupMapping`           | 在上游分组名成为渠道名之前替换其中的片段：`{ "antigravity": "AG" }`。详见下方"分组名片段替换"。                          |

### new-api 提供商 (`type: "newapi"`)

| 字段                     | 必填 | 说明                                           |
| ------------------------ | ---- | ---------------------------------------------- |
| `name`                   | 是   | 唯一标识符，用作渠道标签                       |
| `baseUrl`                | 是   | 提供商地址                                     |
| `systemAccessToken`      | 是   | 提供商的系统访问令牌                           |
| `userId`                 | 是   | 你在提供商上的用户 ID                          |
| `enabledVendors`         |      | 按厂商筛选：`anthropic`、`openai`、`google` 等 |
| `enabledModels`          |      | Glob 模式或单模型覆盖（见下方）                |
| `testModelTypes`         |      | 覆盖全局测试类型：`["text", "image"]`          |
| `priceAdjustment`        |      | 数字或按键对象（见下方"价格调整"）             |
| `perUpstreamConcurrency` |      | 覆盖全局的单上游并发上限                       |

### OpenRouter 提供商 (`type: "openrouter"`)

接入 [OpenRouter](https://openrouter.ai/)。`prompt=0` 且 `completion=0` 的模型作为免费层；付费模型按厂商聚合到一个渠道，并从候选倍率梯度 `[1, 0.5, 0.25, 0.1, 0.05, 0.01]` 中挑选一个共享的 `group_ratio`，使保留下来的所有模型都不会高于官方零售价。在任何候选下都无法满足上限的模型会被丢弃。

| 字段                     | 必填 | 说明                                                        |
| ------------------------ | ---- | ----------------------------------------------------------- |
| `name`                   | 是   | 唯一标识符，用作渠道标签                                    |
| `apiKey`                 | 是   | OpenRouter API 密钥                                         |
| `baseUrl`                |      | 默认 `https://openrouter.ai/api`                            |
| `models`                 |      | 显式模型 ID（如 `moonshotai/kimi-k2.6:free`），跳过自动发现 |
| `enabledVendors`         |      | 按 ID 前缀筛选厂商（`anthropic`、`openai` 等）              |
| `enabledModels`          |      | Glob 模式。无通配的纯 ID 也会加入候选集                     |
| `ratio`                  |      | 免费层组倍率（默认 `0`）                                    |
| `testModelTypes`         |      | 覆盖全局测试类型                                            |
| `priceAdjustment`        |      | 数字或按键对象（见下方"价格调整"）                          |
| `perUpstreamConcurrency` |      | 覆盖全局的单上游并发上限                                    |

### NVIDIA NIM 提供商 (`type: "nvidia"`)

接入 [NVIDIA NIM](https://build.nvidia.com/)。文本模型作为免费层发布；图像模型使用按次定价（`quotaType: 1`），单独走 `imageBaseUrl`。

| 字段                     | 必填 | 说明                                          |
| ------------------------ | ---- | --------------------------------------------- |
| `name`                   | 是   | 唯一标识符，用作渠道标签                      |
| `apiKey`                 | 是   | NVIDIA API 密钥                               |
| `baseUrl`                |      | 默认 `https://integrate.api.nvidia.com`       |
| `imageBaseUrl`           |      | 默认 `https://ai.api.nvidia.com`              |
| `models`                 |      | 显式模型 ID（跳过自动发现）                   |
| `enabledVendors`         |      | 按推断厂商筛选                                |
| `enabledModels`          |      | Glob 模式。无通配的图像模型 ID 也会加入候选集 |
| `ratio`                  |      | 文本层组倍率（默认 `1`）                      |
| `testModelTypes`         |      | 覆盖全局测试类型                              |
| `priceAdjustment`        |      | 数字或按键对象（见下方"价格调整"）            |
| `perUpstreamConcurrency` |      | 覆盖全局的单上游并发上限                      |

### 黑名单

`blacklist` 会从同步中移除匹配的文本模型。非文本类型（图像、视频、音频、嵌入）不会被黑名单过滤。

- **大小写不敏感**，按模型 ID 匹配。
- **支持 Glob 通配符**：`gpt-5.*-codex`、`*-preview`。
- **提供商作用域模式**使用 `provider/pattern` 语法。斜杠前的部分需与提供商的 `name` 匹配，斜杠后是 Glob 模式。示例：

  ```yml
  blacklist:
    - nsfw # 不限作用域：屏蔽任何提供商中包含 "nsfw" 的模型
    - "*-preview" # 不限作用域：屏蔽任何提供商的预览模型
    - duck/gpt-5* # 作用域：仅屏蔽 "duck" 提供商的 gpt-5* 模型
    - yun/claude-*-opus # 作用域：仅屏蔽 "yun" 提供商的 claude opus 模型
  ```

此外还会自动合并一份内置黑名单，用于过滤一小批上游一致出错或类型错配（被当作 `text` 暴露的嵌入 / 音频 / 视频模型）的模型 ID。无需在你的配置里重复。

### 分组名片段替换

`groupMapping` 会在上游分组名成为渠道名与分组名（`<分组名>-<提供商>-<模型>`）之前，替换其中的一个片段。通道本身、定价和上游令牌都不受影响，只有对外名称改变。

- **键**是要在分组名中查找的片段，大小写不敏感。`provider/fragment` 形式将规则限定到某一个提供商。
- **值**只替换该片段，分组名的其余部分保持不变，例如 `duck/Antigravity: pool-a` 会把 `Gemini-CLI-Antigravity` 变为 `Gemini-CLI-pool-a`。
- 作用域规则先于全局规则执行，较长片段先于较短片段，每条规则执行一次。
- 黑名单先按原始分组名与描述执行；规则不会让已被黑名单排除的分组重新进入。若想重命名而不是丢弃某个品牌通道，请把该品牌词从黑名单中移除，并为它添加一条不限作用域的规则。
- **现有渠道会就地重命名**：`sync metadata`（以及 `sync run` 开始时）会找出备注中仍带有改写前分组名的渠道，把它们的 `GroupRatio` / `UserUsableGroups` / `AutoGroups` 键迁移到新名称，再重命名渠道记录。渠道 ID 与统计保留，不创建也不删除任何内容。可用 `sync metadata --dry-run` 预览。
- 若目标名称已存在同名渠道，该重命名会被跳过并记录为冲突。

  ```yml
  groupMapping:
    antigravity: AG # 所有提供商：Gemini-CLI-Antigravity -> Gemini-CLI-AG
    pol/adobe: AD # 仅 pol：image2c-adobe -> image2c-AD
  ```

### 价格调整

`priceAdjustment` 接受单个数字或按键对象：

- **数字：** 统一应用，必须落在开区间 `(-1, 1)`。`-0.5` = 便宜 50%，`0.1` = 贵 10%。
- **对象：** 按模型名称 Glob、厂商名称、模型类型或 `default` 作为键。按此顺序解析，必须包含 `default` 键。非文本类型对应的数值键最高可到 `1`；文本类型的键（厂商、最终落到文本模型上的 Glob 以及 `default`）必须小于 `1`，确保渠道价格不会高于直接调用上游。示例：

  ```yml
  priceAdjustment:
    default: -0.3
    image: 0.5
    anthropic: -0.1
    gpt-5*: -0.5
  ```

### 通过 `enabledModels` 设置单模型覆盖

`enabledModels` 接受字符串 Glob，或以 `model` 为键的对象：

```yml
enabledModels:
  - "claude-*-4-5*" # 普通 Glob
  - model: "gpt-5"
    metadata:
      maxOutputTokens: 32768
      isReasoning: true
  - type: "image"
    model: "flux-pro"
    modelPricingGrid:
      - { "size": "1024x1024", "price": 0.04 }
      - { "size": "2048x2048", "price": 0.08 }
```

- `metadata` 会写入 new-api 的单模型 `metadata` JSON 列（客户端 UI 据此触发针对单个模型的行为，例如为推理模型放大 `max_tokens`）。
- `modelPricingGrid` 用于为图像 / 视频 / 音频模型定义按次的固定价格表。

## 兼容原版 new-api

同步工具既支持 unorouter 分支，也支持原版 [new-api](https://github.com/QuantumNous/new-api)。首次使用时会探测一条仅分支才有的路由；面对原版网关时打印一次 `vanilla new-api (no sync routes)` 并自动降级：

| 功能                       | 分支                                | 原版 new-api                                  |
| -------------------------- | ----------------------------------- | --------------------------------------------- |
| 鉴权                       | 专用同步令牌或管理员令牌            | 管理员访问令牌（写 `/api/option/` 需要 root） |
| 模型列表                   | `GET /api/models/list`              | `GET /api/models/`                            |
| 孤立模型清理               | `DELETE /api/models/orphaned`       | 跳过                                          |
| 访客令牌模型限制           | `PUT /api/token/guest-model-limits` | 标准令牌更新（令牌须属于该访问令牌的用户）    |
| 模型元数据（上下文、标签） | `models.metadata` 列                | 原版无此列；描述、标签、厂商与端点照常写入    |

其余功能（渠道、厂商、选项映射、能力表重建、令牌）使用双方共有的路由。

## 工作原理

1. **发现**：从每个提供商获取模型 / 组，按厂商、黑名单和 Glob 模式筛选；按 `groupMapping` 替换分组名片段
2. **测试**：通过最小化 API 请求验证每个模型
3. **构建目标状态**：合并定价（GroupRatio、ModelRatio、CompletionRatio），构建渠道和策略
4. **差异比较**：将目标状态与当前目标实例状态进行比较
5. **应用**：创建、更新和删除渠道、模型和选项
6. **清理**：移除孤立模型

渠道命名为 `{group}-{provider}`。当某个提供商的模型分裂为多个价格层时，渠道会追加数字后缀：`{group}-{provider}-t0`、`-t1` 等。进一步分裂（由单模型价格覆盖或任务模型固定触发）会追加字母：`-t0a`、`-t0b`。优先级动态分配：最便宜的组优先，响应更快的获得更高优先级。

## 行为说明

### 无利润文本模型会被跳过（默认开启）

默认情况下，有效倍率（组倍率 x `priceAdjustment`）>= 1.0 的文本模型会被跳过，避免同步产生比直接调用上游还贵的渠道。非文本类型（图像、视频、音频、嵌入）不受此限制。

通过全局配置关闭：

```yml
skipUnprofitableText: false
```

### 硬性价格上限

除了无利润文本门槛之外，任何会让用户支付高于官方零售倍率（按 LiteLLM、OpenRouter、basellm 顺序解析）的报价都会在同步前被丢弃。这一上限没有用户侧开关，恒为官方零售的 1 倍。该规则适用于 OpenRouter 付费报价。

### 任务模型渠道固定

部分视频 / 图像模型会被固定到 new-api 中的特定渠道类型：`sora`、`kling`、`vidu`、`jimeng`、`hailuo`、`seedance`、`veo`、`imagen`、`wan`。其中一些还会在提供商 `baseUrl` 后追加路径后缀（例如 `wan` 变为 `/alibailian`）。该行为自动触发，会产生独立子渠道。

### 模型元数据补全

同步过程中，会从两个公开数据源拉取模型描述和标签，用于丰富 new-api 中展示的元数据：

- [OpenRouter `/api/v1/models`](https://openrouter.ai/api/v1/models)：描述（优先）
- [basellm `llm-metadata`](https://basellm.github.io/llm-metadata/api/newapi/models.json)：描述（备用）与标签

此为尽力而为：失败仅记录警告，不会阻塞同步。模糊名称匹配会处理版本与日期后缀的变体（`claude-sonnet-4-5-20250929` 解析为 `claude-sonnet-4.5`）。

### 真伪自动黑名单

`logs/authenticity-blacklist.json` 由测试运行器自动维护，用于记录通过真伪校验失败的 Anthropic Claude 模型提供商。它属于内部状态，但可以在 UI 的"History"标签中查看与移除条目。
