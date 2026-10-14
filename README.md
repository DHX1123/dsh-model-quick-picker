<div align="center">

# dsh-model-quick-picker

**双栏模型选择器 · 附属于 [dsh-our-free-model](https://github.com/Fish-under-sea/dsh-our-free-model-fish) 的配套插件**

**简体中文** | [English](README_EN.md)

<img alt="license" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
<img alt="dependencies" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
<img alt="build step" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
<img alt="status" src="https://img.shields.io/badge/status-beta-f0a441?style=flat-square">

</div>

> **配套插件说明**：本插件是 [dsh-our-free-model](https://github.com/Fish-under-sea/dsh-our-free-model-fish)
> 的**可选附属插件**。它读取该插件渠道的**剩余积分 / 余额**并显示在对话框上，
> 但**不依赖它**——没装 free model 时，本插件仍是一个完整可用的双栏模型选择器，
> 只是不显示积分。两者可独立安装、独立卸载。

## 它解决什么问题

供应商一多，官方的模型菜单就变成**一大长条**：几十个模型挤在一个平面列表里，
既看不出哪个模型属于哪个供应商，也看不到"这个渠道还剩多少额度"。

本插件把这个菜单换成**双栏 + 搜索**的选择器，并把每个供应商的**附加信息**
（积分 / 余额 / 额度）直接摆在决策点上。

## 功能

| 功能 | 说明 |
|---|---|
| **双栏布局** | 左栏供应商、右栏该供应商的模型；悬停左栏即时切换右栏 |
| **常显搜索** | 输入即跨供应商过滤，命中结果平铺为「供应商 › 模型」 |
| **最近使用** | 记录最近选过的模型（localStorage，最多 6 条），置顶显示 |
| **思考等级横排** | 面板底部常驻一排胶囊，**直接点选**，不进次级菜单；点选不关闭面板，方便连续比较 |
| **供应商附加信息** | 左栏每行显示该供应商的剩余积分/余额；对话框上的小标同步显示**当前**供应商的数值 |
| **推理等级同步** | 选择模型时带上该模型的默认等级，切换等级走官方 `selectModel` 通道 |

## 附加信息从哪来

三个**能力探测**适配器，按供应商路由 id 自动匹配。**任何一个读不到都只是不显示，
绝不报错、绝不影响选择器**：

| 供应商类型 | 数据源 | 键 |
|---|---|---|
| 免费渠道（CodeBuddy / TRAE / Qoder / ZCode…） | channel-pack RPC `credits.balances` | 渠道 id |
| 官方（DeepSeek） | `GET /api/billing/balance` | 厂商显示名 |
| 中转站（pi-ai 路由） | `GET /api/billing/relay-quotas` | 路由名 |

免费渠道的口径与 free model 设置页「剩余积分 N」**完全一致**（同一个 RPC、
同样的 `balance.total` 求和、同样的数字缩写），所以两处显示的数字必然相同。

## 安装

### 通过插件市场（推荐）

在 dsh 插件市场里搜索本仓库，或直接给出 GitHub 规格：

```
github:DHX1123/dsh-model-quick-picker
```

### 手动安装

把本目录放进 profile 并声明为 bundle：

```jsonc
// <profile>/package.json
{
  "dependencies": {
    "dsh-model-quick-picker": "link:./plugins/dsh-model-quick-picker"
  },
  "dsh": {
    "profile": {
      "bundles": [ /* … , */ "dsh-model-quick-picker" ]
    }
  }
}
```

然后在该 profile 目录下运行 `pnpm install` 同步锁文件。

> ⚠️ **不要只改 `package.json` 而不跑 pnpm**。profile 是 pnpm workspace，
> dshmarket 以 `CI=true`（frozen-lockfile）运行 pnpm；清单与锁文件不一致会让
> 它硬失败，并触发"禁用第三方插件"的恢复流程，**连带重置 `cordis.patch.yml`**。
> 优先用插件市场的安装入口，它会把三层（依赖、bundles、patch 行）一次写对。

### 生效

**客户端插件必须重启宿主应用。** 浏览器刷新**无效**——`client.js` 是宿主启动时
读取并快照的，改磁盘文件后只有重启才会重新装载。

## 卸载 / 回退

用插件市场关掉，或从 `dsh.profile.bundles` 移除该行后重启。
本插件**不修改任何官方文件**，卸载后官方模型选择器原样回来。

## 它是怎么接进去的

本插件**影子替换**官方的模型位，而不是新增一个入口：

```js
ctx.slots.inject('conversation.input.model', () => ctx.slots.register({
  name: 'conversation.input.model',
  priority: -10,          // 官方是 0，lowest renders ⇒ -10 胜出
  inject: (sessionId) => { /* … */ },
}, Component))
```

积分小标则注册到 `conversation.input.right`（一个 `list` 槽位），
用独立 `id` 与其它插件的 composer 控件**并存**。

零依赖、无构建步骤：`client.js` 直接以 `window.__ModuleLoader__.load` 形式交付，
React 从宿主模块表取用。

## 兼容性

- 需要 dsh `0.2.0-rc` 系列的客户端槽位契约（`conversation.input.model` 为 `single` 槽位）。
- 图标与主题 token 全部做了**防御性取用**（`?.` + 错误边界）：宿主升级导致图标改名时，
  本插件会安静退场，**不会**弄丢模型入口。
- 附加信息依赖其它插件的 HTTP/RPC 面，属于**装饰层**：那些插件升级改了路由，
  最坏结果是数值不显示。

## 许可

MIT

## 相关

- [dsh-our-free-model](https://github.com/Fish-under-sea/dsh-our-free-model-fish) — 本插件所附属的免费模型插件
- [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) — 上游原仓库
