# B 站 / 学习通 课程实时笔记助手

把「看视频课程」自动变成「有 Word 笔记 + 有长期记忆」：定时观察浏览器前台窗口，识别正在看的视频课程，按学科归类，抓取内容做知识总结，输出 Word 知识地图，并把每个视频的笔记**自动投递到一个新建会话的对话框里**。

工作区结构（本仓库根就是插件本体）：

```
<本仓库>
├── lib\index.js           # 检测 / 分类 / 抓取 / 生成 / Word / 投递
├── scripts\md2docx.py     # Markdown → Word（含 mermaid mindmap → 原生分级大纲）
├── test\                  # 单测 + 离线集成测试 + 联网抓取测试
└── 课程知识地图\           # 输出目录（运行时生成，已 gitignore）
    ├── 课程总览.docx
    ├── <学科>\学习手册.docx
    ├── <学科>\<视频标题>.docx   # 单视频笔记（投递物）
    └── .state\               # state.json / poll.log / manuals
```

## 它做什么

| 功能 | 行为 |
|---|---|
| 实时检测 | 每 15 秒读前台窗口标题；浏览器/视频客户端 + 连续 2 次同一标题才处理 |
| 静默去重 | 处理过的视频记 `seen`，再看到不重复生成、不建会话 |
| 学科分类 | LLM 按标题+关键词判定学科；老学科追加进《学习手册》，新学科建目录 |
| 内容抓取 | B 站：搜索反查 → 简介/标签/字幕/弹幕(≤150)/热评(≤3)；学习通：无公开接口，降级标题级总结且禁止编造 |
| 知识总结 | 生成 Markdown + Mermaid 思维导图，落成 Word |
| 自动投递 | 建新会话（标题「课程笔记｜<视频名>」），把该视频 Word 作为文件卡投递进对话框 |
| 娱乐/游戏过滤 | 综艺、搞笑、短剧、游戏实况/攻略等一律 `isCourse=false`，静默忽略，**不录入** |

> 游戏开发的**教学**内容（Unity/Unreal 编程教程、图形学）算知识课程，不受过滤影响。

## 支持平台

- **B 站**：完整支持，含弹幕与评论。
- **学习通 / 超星 / 学堂在线 / 智慧树 / 知到 / 中国大学MOOC**：识别页面标题并归类；因无公开内容接口，走标题级降级总结（明确要求模型不得虚构章节编号/教师原话）。
- 其它平台：能识别标题就按标题级总结处理。

## 配置

profile 配置（`~/.dsh/profiles/desktop/cordis.patch.yml`）：

```yaml
- id: dsh-course-notes
  name: dsh-course-notes
  config:
    outputDir: ./课程知识地图
    pollIntervalMs: 15000
    stablePolls: 2
    deliver: true
    deliverMode: wakeup
    perVideoDocx: true
    maxDeliveriesPerHour: 12
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `pollIntervalMs` | 15000 | 轮询间隔（毫秒） |
| `stablePolls` | 2 | 连续 N 次同标题才处理（防标签切换抖动） |
| `outputDir` | `<工作区>/课程知识地图` | 输出目录 |
| `titleMinLen` | 4 | 标题最小长度 |
| `fetchContent` | true | 是否抓 B 站内容 |
| `perVideoDocx` | true | 是否额外产出单视频 Word |
| `deliver` | true | 是否投递到新会话 |
| `deliverMode` | `wakeup` | `wakeup`=跑一轮（文件卡+present 交付卡片+可写记忆，耗一次模型调用）；`append`=零 token 落消息（有文件卡，无交付卡片、不写记忆） |
| `deliverProvider` / `deliverModel` | null | 投递会话模型，null 跟随 DSH 默认 |
| `deliverSummary` | true | 投递消息是否带关键词摘要 |
| `maxDeliveriesPerHour` | 12 | 每小时最多新建会话数 |
| `maxSeenAttempts` | 3 | 同一标题分类连续失败几次后放弃 |

## 工具

| 工具 | 说明 |
|---|---|
| `course_map_status` | 状态：启用、输出目录、投递配置、学科与视频数、静默忽略统计、最近投递 |
| `course_map_scan` | 立即扫一次；可传 `title`、`platform`(bilibili/xuexitong)、`force`(忽略去重) |

## 用法

```text
course_map_status
course_map_scan {"title":"计算机网络 第2章 TCP三次握手 - 学习通"}
course_map_scan {"title":"某视频 - Google Chrome","force":true}
```

平时不用管：打开 B 站课程页或学习通课程页，等 2 个轮询周期就会自动产出并投递。

## 关键修复（相对 dsh-video-coursemap 2.0.0）

1. **检测永久失效**：Edge 标题是 `…_哔哩哔哩_bilibili 和另外 5 个页面 - 用户配置 1 - Microsoft​ Edge`，其中 `Microsoft` 与 `Edge` 之间夹着零宽字符 `U+200B`，原实现按 `endswith(" - Microsoft Edge")` 永远匹配不上；残留的「哔哩哔哩」又触发「通用页」守卫，导致 `state.json` 从未生成。
   现在：先清不可见字符 → 剥「和另外 N 个页面」「- 用户配置 N」→ 再剥浏览器/平台后缀；通用页判定改为「以平台名**开头**」。
2. **内容抓取形同虚设**：原实现只比对搜索结果第 1 条并要求相似度 ≥0.5，而精确匹配常见于第 2~3 条。现在遍历前 20 条取最佳匹配，首轮无命中再用去装饰标点的关键词回退搜索。
3. **追加**：单视频 Word、投递到新会话、娱乐/游戏过滤、学习通支持、分类失败重试上限、状态里展示忽略统计。

## 测试

```bash
# 单测（无需网络）
ELECTRON_RUN_AS_NODE=1 "<DSH 安装目录>/DeepSeek Harness.exe" test/title.test.mjs
ELECTRON_RUN_AS_NODE=1 "<DSH 安装目录>/DeepSeek Harness.exe" test/platform.test.mjs
ELECTRON_RUN_AS_NODE=1 "<DSH 安装目录>/DeepSeek Harness.exe" test/nonknowledge.test.mjs
# 离线集成（假 ctx，跑通建会话/附件/改名/过滤/append 零 token）
ELECTRON_RUN_AS_NODE=1 "<DSH 安装目录>/DeepSeek Harness.exe" test/delivery.integration.mjs
# 联网（验证 B 站反查 + 弹幕/评论）
ELECTRON_RUN_AS_NODE=1 "<DSH 安装目录>/DeepSeek Harness.exe" test/bili.fetch.mjs
```

## 排障

| 现象 | 排查 |
|---|---|
| 前台是 B 站但没反应 | 看 `.state/poll.log` 有没有 `browser proc=… cleaned=…`；没这行说明前台进程名不在浏览器白名单 |
| 一直静默 | 标题可能已处理过（`state.json` 的 `seen`）或被判为非知识内容（日志 `skip non-knowledge category=…`） |
| 没有新会话 | 日志 `deliver error` / `deliver skipped`；或每小时上限、`deliver:false` |
| Word 没生成 | 日志 `video docx error`；确认捆绑 Python 带 python-docx |
| 改了插件代码没生效 | 宿主插件不热重载：断开再启用插件，或重启 DSH |

## 成本（实测，非估算）

插件不下载视频、不做语音转写，只取**截断后的文本**：简介 ≤800 字、字幕 ≤1500 字、弹幕 ≤120 行、热评 ≤20 条。所以**20 分钟和 2 小时视频花的一样多**——成本与视频时长无关。

单视频实测（`deepseek-flash`，取自 `.state/poll.log` 的 `usage` 行）：

| 阶段 | 输入 | 输出 |
|---|---|---|
| 分类 classify | ≈ 611 | ≈ 168 |
| 总结 generate（内容充足） | ≈ 1,666 | ≈ 2,937 |
| 总结 generate（抓取稀疏） | ≈ 538 | ≈ 1,425 |
| 投递回合（wakeup） | ≈ 2,135 | ≈ 285（另有 ≈13,440 缓存读，单价更低） |

⇒ 每个视频约 **4.4k 输入 + 3.4k 输出**；看 10 个视频/天约 **44k 输入 + 34k 输出**（≈132 万输入 + 102 万输出/月）。

闲置（DSH 在前台、无浏览器、逛非课程网站）为 **0 token**：

- 只对已知平台（B 站/学习通/超星/学堂在线/智慧树/知到/中国大学MOOC）做分类
- 分类最小间隔 60s、每小时上限 30 次

省钱开关：`deliverMode: append` 可省掉最贵的投递回合（约 2.1k 输入 + 0.3k 输出/视频），代价是不写记忆、无 `present` 卡片。

实际金额 = `输入token/1e6 × 输入单价 + 输出token/1e6 × 输出单价`，单价以「设置 → 账号余额」为准。

## 需要重启 DSH 才会生效的一项

`dsh-memory-evolve` 已加入 profile 的 `dsh.profile.bundles`，但要**完全重启 DeepSeek Harness** 才会真正加载。加载后：新会话自动带记忆快照，且 `memory` 工具可用（当前投递指令已写成「有 memory 工具才写记忆，没有就跳过，不要用 edit 改记忆文件」）。
