[English](README.md) | 中文

# new-api-sync

将上游提供商的定价、渠道和模型同步到你的 [new-api](https://github.com/unorouter/new-api) 实例。支持 [new-api](https://github.com/unorouter/new-api)、[sub2api](https://github.com/unorouter/sub2api)、厂商直连 API 以及 NVIDIA NIM。

## 快速开始

```bash
bun install
cp config.example.jsonc config.jsonc  # 编辑你的配置
bun sync run                          # 运行同步
bun sync run --only myprovider        # 仅同步指定提供商
bun sync reset                        # 删除所有已同步数据
```

## 模型测试

```bash
bun sync test                         # 测试所有提供商的全部模型
bun sync test --only myprovider       # 测试指定提供商
```

`test` 命令会测试所有组中的每个模型，但不会对目标实例做任何更改。结果保存在 `logs/YYYY-MM-DD-model-tests.json`。同一天再次运行会跳过已通过的模型，只重测失败项，因此可以恢复中断的运行。

测试会忽略 `enabledVendors` 和 `enabledModels` 筛选器，并测试所有模型类型。`config.jsonc` 中的 `testModelTypes` 可以按提供商控制常规同步时测试的模型类别（如 `["text", "image"]`）。省略则默认只测试文本模型。

## 配置

### 目标 (target)

| 字段                | 说明                              |
| ------------------- | --------------------------------- |
| `baseUrl`           | 你的 new-api 实例地址             |
| `systemAccessToken` | 系统访问令牌（设置 > 其他）       |
| `userId`            | 你的用户 ID                       |
| `targetPrefix`      | 可选的同步资源前缀                |

### 全局选项

| 字段             | 说明                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `testModelTypes` | 同步时测试的模型类型：`["text", "image", "video", "audio", "embedding"]`（默认：`["text"]`）。提供商级别设置可覆盖全局。 |
| `blacklist`      | 排除匹配的组/模型：`["kiro", "nsfw"]`                                                                    |
| `modelMapping`   | 重命名模型：`{ "claude-sonnet-4-5-20250929-thinking": "claude-sonnet-4-5-20250929" }`                     |

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

### NVIDIA NIM 提供商 (`type: "nvidia"`)

连接 NVIDIA NIM API。文本模型自动发现；图像模型需在 `enabledModels` 中列出。

| 字段             | 必填 | 说明                                                                     |
| ---------------- | ---- | ------------------------------------------------------------------------ |
| `name`           | 是   | 唯一标识符，用作渠道标签                                                 |
| `apiKey`         | 是   | NVIDIA API 密钥                                                          |
| `baseUrl`        |      | 文本模型端点（默认 `https://integrate.api.nvidia.com`）                  |
| `imageBaseUrl`   |      | 图像模型端点（默认 `https://ai.api.nvidia.com`）                         |
| `models`         |      | 显式模型列表（跳过自动发现）                                             |
| `enabledModels`  |      | Glob 模式；字面量图像模型名称会自动加入发现                              |
| `ratio`          |      | 基础组倍率（默认 1.0）                                                   |
| `testModelTypes` |      | 覆盖全局测试类型                                                         |
| `priceAdjustment`|      | 数字或按键对象（见下方"价格调整"）                                       |

### 价格调整

`priceAdjustment` 接受单个数字或按键对象：

- **数字：** 统一应用。`-0.5` = 便宜 50%，`0.1` = 贵 10%。
- **对象：** 按模型名称 Glob、厂商名称、模型类型或 `"default"` 作为键。按此顺序解析，必须包含 `"default"` 键。示例：
  ```jsonc
  { "default": -0.3, "image": 0.5, "anthropic": -0.1, "gpt-5*": -0.5 }
  ```

### 其他选项

- **`enabledModels`** 支持 Glob 模式：`claude-*-4-5*` 匹配 `claude-sonnet-4-5-20250929`，`*-preview` 匹配所有以 `-preview` 结尾的模型

## 工作原理

1. **发现** — 从每个提供商获取模型/组，按厂商、黑名单和 Glob 模式筛选
2. **测试** — 通过最小化 API 请求验证每个模型
3. **构建目标状态** — 合并定价（GroupRatio、ModelRatio、CompletionRatio），构建渠道和策略
4. **差异比较** — 将目标状态与当前目标实例状态进行比较
5. **应用** — 创建、更新和删除渠道、模型和选项
6. **清理** — 移除孤立模型

渠道命名为 `{group}-{provider}`。优先级动态分配：最便宜的组优先，响应更快的获得更高优先级。
