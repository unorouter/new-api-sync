[English](README.md) | 中文

> 友情链接：[LINUX DO](https://linux.do/) - 新的理想型社区

# new-api-sync

将上游提供商的定价、渠道和模型同步到你的 [new-api](https://github.com/QuantumNous/new-api) 实例。支持 [new-api](https://github.com/QuantumNous/new-api)、[sub2api](https://github.com/Wei-Shaw/sub2api) 以及厂商直连 API。

## 快速开始

```bash
bun install
cp config.example.yml config.yml      # 编辑你的配置
bun sync run                          # 运行同步
bun sync run --only myprovider        # 仅同步指定提供商
bun sync run --verbose                # 以调试日志级别运行
bun sync reset                        # 删除所有已同步数据
```

## 模型测试

```bash
bun sync test                         # 测试所有提供商的全部模型
bun sync test --only myprovider       # 测试指定提供商
bun sync test --verbose               # 以调试日志级别测试
```

`test` 命令会测试所有组中的每个模型，但不会对目标实例做任何更改。结果保存在 `logs/YYYY-MM-DD-model-tests.json`。同一天再次运行会跳过已通过的模型，只重测失败项，因此可以恢复中断的运行。

测试会忽略 `enabledVendors`、`enabledModels` 以及倍率阈值过滤器（详见"行为说明"），并测试所有模型类型。`config.yml` 中的 `testModelTypes` 可以按提供商控制常规同步时测试的模型类别（如 `[text, image]`）。省略则默认只测试文本模型。

## 配置

### 目标 (target)

| 字段                | 说明                              |
| ------------------- | --------------------------------- |
| `baseUrl`           | 你的 new-api 实例地址             |
| `systemAccessToken` | 系统访问令牌（设置 > 其他）       |
| `userId`            | 你的用户 ID                       |
| `targetPrefix`      | 可选的同步资源前缀                |

### 全局选项

| 字段                   | 说明                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `testModelTypes`       | 同步时测试的模型类型：`["text", "image", "video", "audio", "embedding"]`（默认：`["text"]`）。提供商级别设置可覆盖全局。 |
| `skipUnprofitableText` | 跳过有效倍率 ≥ 1 的文本模型（默认：`true`）。详见下方"行为说明"。                                                         |
| `blacklist`            | 排除匹配的文本模型（大小写不敏感）。支持 Glob 通配符和提供商作用域模式。详见下方"黑名单"。                              |
| `modelMapping`         | 重命名模型：`{ "claude-sonnet-4-5-20250929-thinking": "claude-sonnet-4-5-20250929" }`                                    |

### new-api 提供商 (`type: "newapi"`)

| 字段                | 必填 | 说明                                            |
| ------------------- | ---- | ----------------------------------------------- |
| `name`              | 是   | 唯一标识符，用作渠道标签                        |
| `baseUrl`           | 是   | 提供商地址                                      |
| `systemAccessToken` | 是   | 提供商的系统访问令牌                            |
| `userId`            | 是   | 你在提供商上的用户 ID                           |
| `enabledVendors`    |      | 按厂商筛选：`anthropic`、`openai`、`google` 等  |
| `enabledModels`     |      | Glob 模式：`["claude-*-4-5*", "gpt-5*"]`        |
| `testModelTypes`    |      | 覆盖全局测试类型：`["text", "image"]`           |
| `priceAdjustment`   |      | 数字或按键对象（见下方"价格调整"）              |

### 直连提供商 (`type: "direct"`)

无需中间层，直接连接厂商 API（OpenAI、Anthropic、Google、Moonshot 等）。

| 字段               | 必填 | 说明                                                         |
| ------------------ | ---- | ------------------------------------------------------------ |
| `name`             | 是   | 唯一标识符，用作渠道标签                                     |
| `baseUrl`          | 是   | 厂商 API 基础地址                                            |
| `apiKey`           | 是   | 厂商 API 密钥                                                |
| `vendor`           | 是   | 厂商名称：`openai`、`anthropic`、`google`、`moonshot` 等     |
| `models`           |      | 显式模型列表（跳过自动发现）                                 |
| `enabledModels`    |      | 自动发现模型的 Glob 模式：`["kimi-*"]`                       |
| `channelType`      |      | 覆盖推断的渠道类型编号                                       |
| `ratio`            |      | 基础组倍率（默认 1.0）                                       |
| `discoverEndpoint` |      | 自定义发现端点（默认 `/v1/models`）                          |
| `testModelTypes`   |      | 覆盖全局测试类型                                             |
| `priceAdjustment`  |      | 数字或按键对象（见下方"价格调整"）                           |

### sub2api 提供商 (`type: "sub2api"`)

提供 `adminApiKey`（自动发现组）或 `groups`（显式组 API 密钥）。

| 字段             | 必填 | 说明                                                              |
| ---------------- | ---- | ----------------------------------------------------------------- |
| `name`           | 是   | 唯一标识符，用作渠道标签                                          |
| `baseUrl`        | 是   | Sub2API 实例地址                                                  |
| `adminApiKey`    |      | 管理员 API 密钥，自动发现组、账户和模型                           |
| `groups`         |      | 显式组：`[{ "key": "sk-...", "platform": "anthropic" }]`          |
| `enabledVendors` |      | 按厂商筛选：`anthropic`、`openai`、`google`                       |
| `enabledModels`  |      | Glob 模式：`["claude-*-4-5*", "gpt-5*"]`                          |
| `testModelTypes` |      | 覆盖全局测试类型                                                  |
| `priceAdjustment`|      | 数字或按键对象（见下方"价格调整"）                                |

### 黑名单

`blacklist` 会从同步中移除匹配的文本模型。非文本类型（图像、视频、音频、嵌入）不会被黑名单过滤。

- **大小写不敏感**，按模型 ID 匹配。
- **支持 Glob 通配符**：`gpt-5.*-codex`、`*-preview`。
- **提供商作用域模式**使用 `provider/pattern` 语法。斜杠前的部分需与提供商的 `name` 匹配，斜杠后是 Glob 模式。示例：

  ```yml
  blacklist:
    - nsfw               # 不限作用域：屏蔽任何提供商中包含 "nsfw" 的模型
    - "*-preview"        # 不限作用域：屏蔽任何提供商的预览模型
    - duck/gpt-5*        # 作用域：仅屏蔽 "duck" 提供商的 gpt-5* 模型
    - yun/claude-*-opus  # 作用域：仅屏蔽 "yun" 提供商的 claude opus 模型
  ```

### 价格调整

`priceAdjustment` 接受单个数字或按键对象：

- **数字：** 统一应用。`-0.5` = 便宜 50%，`0.1` = 贵 10%。
- **对象：** 按模型名称 Glob、厂商名称、模型类型或 `default` 作为键。按此顺序解析，必须包含 `default` 键。示例：
  ```yml
  priceAdjustment:
    default: -0.3
    image: 0.5
    anthropic: -0.1
    gpt-5*: -0.5
  ```

### 其他选项

- **`enabledModels`** 支持 Glob 模式：`claude-*-4-5*` 匹配 `claude-sonnet-4-5-20250929`，`*-preview` 匹配所有以 `-preview` 结尾的模型

## 工作原理

1. **发现**：从每个提供商获取模型/组，按厂商、黑名单和 Glob 模式筛选
2. **测试**：通过最小化 API 请求验证每个模型
3. **构建目标状态**：合并定价（GroupRatio、ModelRatio、CompletionRatio），构建渠道和策略
4. **差异比较**：将目标状态与当前目标实例状态进行比较
5. **应用**：创建、更新和删除渠道、模型和选项
6. **清理**：移除孤立模型

渠道命名为 `{group}-{provider}`。当某个提供商的模型分裂为多个价格层时，渠道会追加数字后缀：`{group}-{provider}-t0`、`-t1` 等。进一步分裂（由单模型价格覆盖或任务模型固定触发）会追加字母：`-t0a`、`-t0b`。优先级动态分配：最便宜的组优先，响应更快的获得更高优先级。

## 行为说明

### 无利润文本模型会被跳过（默认开启）

默认情况下，有效倍率（组倍率 × `priceAdjustment`）≥ 1.0 的文本模型会被跳过，避免同步产生比直接调用上游还贵的渠道。非文本类型（图像、视频、音频、嵌入）不受此限制。测试模式绕过此阈值。

通过全局配置关闭：

```yml
skipUnprofitableText: false
```

### 任务模型渠道固定

部分视频/图像模型会被固定到 new-api 中的特定渠道类型：`sora`、`kling`、`vidu`、`jimeng`、`hailuo`、`seedance`、`veo`、`imagen`、`wan`。其中一些还会在提供商 `baseUrl` 后追加路径后缀（例如 `wan` → `/alibailian`）。该行为自动触发，会产生独立子渠道。

### 模型元数据补全

同步过程中，会从两个公开数据源拉取模型描述和标签，用于丰富 new-api 中展示的元数据：

- [OpenRouter `/api/v1/models`](https://openrouter.ai/api/v1/models)：描述（优先）
- [basellm `llm-metadata`](https://basellm.github.io/llm-metadata/api/newapi/models.json)：描述（备用）与标签

此为尽力而为：失败仅记录警告，不会阻塞同步。模糊名称匹配会处理版本与日期后缀的变体（`claude-sonnet-4-5-20250929` → `claude-sonnet-4.5`）。

### Kiro 自动黑名单

`logs/kiro-blacklist.json` 由测试运行器自动维护，用于记录通过真伪校验失败的 Anthropic Claude 模型提供商。此为内部状态，无需手动编辑。
