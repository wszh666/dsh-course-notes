/**
 * dsh-course-notes — B 站课程实时笔记助手
 *
 * 定时观察 Windows 前台浏览器窗口，识别当前视频课程，按标题/关键词做
 * 学科分类，生成 Markdown + Mermaid 知识地图 / 学习手册，并把单视频
 * Word 笔记投递到一个新建会话的对话框中。
 *
 * 行为：
 *  - 前台窗口是浏览器/视频客户端时，取其标题并归一化 + 剥离平台后缀；
 *  - 标题已处理过 → 静默；
 *  - 新标题（连续 stablePolls 次稳定）→ LLM 判定是否课程 + 学科分类；
 *  - 旧学科 → 追加到已有「学习手册」；新学科 → 新建学习手册；
 *  - 按标题反查 B 站视频，抓取简介/字幕/弹幕/评论，用于知识总结（失败静默降级）；
 *  - 非课程 → 静默忽略（记录到 seen，不再重复询问）；
 *  - 产出单视频 Word 后，新建会话并把该 Word 以文件卡投递到对话框。
 *
 * 纯插件、零 DSH 核心修改。基于 dsh-video-coursemap 2.0.0 改造，
 * 修复了 Edge 多标签标题（零宽字符 + 「和另外 N 个页面」后缀）导致
 * 检测永久失效的问题。
 */

import { execFile, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileP = promisify(execFile)

export const name = 'dsh-course-notes'
export const inject = ['llm', 'tools']
// 导出供测试：标题归一化与"非知识类"判定是本插件的核心规则，需要可直接单测
export { normalizeTitle, isNonKnowledge }

export const DEFAULTS = {
  enabled: true,
  pollIntervalMs: 15000, // 轮询间隔（毫秒）
  stablePolls: 2,        // 连续 N 次观察到同一新标题才处理（防标签切换抖动）
  outputDir: null,       // null → <工作区>/课程知识地图（见 resolveConfig）
  provider: null,        // null → 使用默认模型
  model: null,
  maxTokens: 4096,
  titleMinLen: 4,
  fetchContent: true,    // 抓取 B 站简介/字幕/弹幕/评论用于总结（失败自动降级）
  maxSeenAttempts: 3,    // 同一标题连续失败 N 次后记入 seen，避免无限重试
  // ---- 省钱护栏（日常一直开着时的关键）----
  // 只对「已知视频/课程平台」的页面做 LLM 分类；普通网页（GitHub、搜索页、
  // 文档站…）直接跳过，零 token。关闭后任何浏览器标题都会送模型判定。
  onlyKnownPlatforms: true,
  // 两次 LLM 分类之间的最小间隔（毫秒）。防止快速切标签时连续触发。
  minClassifyGapMs: 60000,
  // 每小时最多做多少次 LLM 分类；超限的标题丢弃（不记 seen，稍后可重试）。
  maxClassifyPerHour: 30,
  perVideoDocx: true,    // 每个视频额外产出独立 Word 笔记
  deliver: true,         // 产出后新建会话并把 Word 投递进对话框
  deliverProvider: null, // 投递会话的 provider；null → 跟随 DSH 默认模型
  deliverModel: null,    // 投递会话的 model；null → 跟随 DSH 默认模型
  // 投递方式：
  //  - 'wakeup'：消息经 followup 唤醒会话跑一轮。文件卡与 present 交付卡片
  //    都会出现，且能调用 memory 工具把学科要点写进长期记忆——会消耗一次
  //    模型调用。
  //  - 'append'：直接把用户消息 append 到会话表面，零 token。文件卡可见，
  //    但没有模型回合，因此不会写记忆、也不会有 present 交付卡片。
  deliverMode: 'wakeup',
  deliverWakeup: true,   // 兼容旧配置：true → deliverMode='wakeup'，false → 'append'
  deliverSummary: true,  // 投递消息里是否带上关键词摘要（false 则只有文件卡）
  maxDeliveriesPerHour: 12, // 每小时最多投递会话数，防会话洪水
}

// 浏览器 / 视频客户端进程名（isBrowserProc 会统一转小写再去 .exe；中文名原样保留）
const BROWSER_PROCESSES = new Set([
  // 浏览器
  'chrome', 'msedge', 'edge', 'firefox', 'iexplore', 'opera', 'brave', 'chromium',
  'vivaldi', 'yandex', 'librewolf', 'waterfox',
  '360chrome', '360se', '360browser', 'qqbrowser', 'sogouexplorer', 'maxthon', 'ucbrowser', 'quark', '夸克',
  // 视频客户端（中文 + 英文进程名都覆盖）
  'bilibili', '哔哩哔哩',
  'douyin', '抖音', 'aweme',
  'kuaishou', '快手',
  'xigua', '西瓜视频',
  'youku', '优酷', 'iqiyi', '爱奇艺', 'pps',
  'qqlive', 'tencentvideo', '腾讯视频',
  'mgtv', '芒果tv', '芒果TV',
  'migu', '咪咕视频',
  'weishi', '微视',
  'sohuvideo', '搜狐视频', 'letv', '乐视',
  // 本地播放器
  'potplayer', 'vlc', 'mpv', 'kmplayer', 'mpc-hc', 'mpc-be',
])

// 标题末尾要剥离的平台/浏览器后缀（循环剥离，处理 "标题 - YouTube - Google Chrome"）
const TITLE_SUFFIXES = [
  ' - Google Chrome', ' - Microsoft Edge', ' - Mozilla Firefox',
  ' - Chromium', ' - Opera', ' - Brave', ' - Internet Explorer',
  ' - 谷歌浏览器', ' - 微软 Edge', ' - 火狐浏览器', ' - 360极速浏览器',
  '_哔哩哔哩_bilibili', '_哔哩哔哩', ' - 哔哩哔哩', ' - bilibili', '-bilibili', ' - Bilibili',
  ' - YouTube', ' - 优酷', ' - 爱奇艺', ' - 腾讯视频', ' - 芒果TV', ' - 抖音', ' - 快手', ' - 夸克', ' - Quark',
  // 学习通 / 超星（含 iframe 章节页常见写法）
  ' - 学习通', '-学习通', '_学习通', ' - 超星学习通', ' - 超星', ' - 超星尔雅',
  '_超星学习通', '_超星', '_超星尔雅', '_学堂在线', '_智慧树', '_知到',
  ' - 学堂在线', ' - 中国大学MOOC', ' - 智慧树', ' - 知到',
]

/**
 * 平台识别：只看「原始前台标题 + 清洗后标题」，决定后续内容抓取走哪条路。
 * - bilibili：走 B 站搜索反查，抓简介/字幕/弹幕/评论
 * - xuexitong：无公开内容接口，降级为「标题 + 学科」推断式总结（不编造事实）
 * - unknown：无法确认平台，同样降级为标题级总结
 */
const XUEXITONG_HINTS = /学习通|超星|chaoxing|xuexitong|mooc|学堂在线|智慧树|知到|中国大学/i

/**
 * 省钱护栏判定：onlyKnownPlatforms 开启时，非已知视频/课程平台的页面
 * 不送模型分类。（日常逛 GitHub、搜索页、文档站时为零 token 的关键。）
 */
export function shouldSkipByPlatform(platform, onlyKnownPlatforms) {
  return onlyKnownPlatforms === true && platform === 'unknown'
}

export function detectPlatform(rawTitle, cleanTitle) {
  const raw = String(rawTitle ?? '')
  const clean = String(cleanTitle ?? '')
  if (XUEXITONG_HINTS.test(raw) || XUEXITONG_HINTS.test(clean)) return 'xuexitong'
  if (/bilibili|哔哩哔哩/i.test(raw) || /bilibili|哔哩哔哩/i.test(clean)) return 'bilibili'
  return 'unknown'
}

// 前台窗口标题读取脚本：结果写入文件，避免 stdout 编码问题（中文 GBK/UTF-8 差异）。
const POLL_PS1 = `param([string]$OutFile)
Add-Type -ErrorAction SilentlyContinue @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FGWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$h = [FGWin]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][FGWin]::GetWindowText($h, $sb, 512)
$procId = 0
[void][FGWin]::GetWindowThreadProcessId($h, [ref]$procId)
$pname = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
$text = "TITLE=" + $sb.ToString() + "\`nPROC=" + $pname
[System.IO.File]::WriteAllText($OutFile, $text, (New-Object System.Text.UTF8Encoding($false)))
`

function resolveConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-course-notes: 配置必须是对象')
  }
  const config = { ...DEFAULTS }
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (!(key in DEFAULTS)) throw new Error(`dsh-course-notes: 未知配置项 "${key}"`)
    config[key] = value
  }
  for (const key of ['pollIntervalMs', 'stablePolls', 'maxTokens', 'titleMinLen', 'maxSeenAttempts', 'maxDeliveriesPerHour', 'minClassifyGapMs', 'maxClassifyPerHour']) {
    const v = config[key]
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(`dsh-course-notes: ${key} 必须是正数`)
    }
  }
  for (const key of ['enabled', 'fetchContent', 'perVideoDocx', 'deliver', 'deliverWakeup', 'deliverSummary', 'onlyKnownPlatforms']) {
    if (typeof config[key] !== 'boolean') throw new Error(`dsh-course-notes: ${key} 必须是布尔值`)
  }
  if (config.deliverMode !== 'wakeup' && config.deliverMode !== 'append') {
    throw new Error(`dsh-course-notes: deliverMode 必须是 'wakeup' 或 'append'`)
  }
  // 兼容旧配置：显式给的 deliverWakeup 覆盖 deliverMode 的默认判断
  if (raw.deliverWakeup === false) config.deliverMode = 'append'
  else if (raw.deliverWakeup === true && raw.deliverMode === undefined) config.deliverMode = 'wakeup'
  for (const key of ['provider', 'model', 'deliverProvider', 'deliverModel']) {
    if (config[key] !== null && (typeof config[key] !== 'string' || config[key].trim() === '')) {
      throw new Error(`dsh-course-notes: ${key} 必须是 null 或非空字符串`)
    }
  }
  // 默认输出到工作区（本插件所在目录的父目录）下的「课程知识地图」，
  // 不再写到用户主目录，保证产物落在用户自己的工作区里。
  config.outputDir = config.outputDir ?? join(WORKSPACE_DIR, '课程知识地图')
  return config
}

function ensureDir(p) { if (!existsSync(p)) mkdirSync(p, { recursive: true }) }

function atomicWrite(file, content) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp.${process.pid}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

function loadState(p) {
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch { return {} }
}

function saveState(p, s) { atomicWrite(p, JSON.stringify(s, null, 2) + '\n') }

function cleanTitle(raw) {
  return normalizeTitle(raw)
}

/**
 * 标题归一化 + 平台后缀剥离（本插件的核心修复点）。
 *
 * 旧实现直接 endswith 匹配「 - Microsoft Edge」，但真实 Edge 标题是：
 *   【课程名】_哔哩哔哩_bilibili 和另外 5 个页面 - 用户配置 1 - Microsoft​ Edge
 * 其中 Microsoft 与 Edge 之间夹着零宽字符 U+200B，且多出「和另外 N 个页面」
 * 「- 用户配置 N」两段，导致一个后缀都匹配不上；残留的「哔哩哔哩」反过来
 * 触发「通用页」守卫，使检测永久失效（state.json 从未生成）。
 *
 * 新实现：先去零宽/不可见字符 → 剥多标签与用户配置段 → 循环剥浏览器/平台
 * 后缀 → 收敛空白。
 */
const INVISIBLE_RE = /[\u200b-\u200f\u2060\ufeff\u00ad]/g
const TABBED_SUFFIX_RE = /\s*(?:和另外\s*\d+\s*个页面|-\s*用户配置\s*\d+)\s*/g
const BROWSER_TAIL_RE = /\s*[-–—]\s*(?:Google Chrome|Microsoft Edge|Mozilla Firefox|Chromium|Opera|Brave|Internet Explorer|Vivaldi|Yandex|360极速浏览器|360安全浏览器|谷歌浏览器|微软\s*Edge|火狐浏览器|Microsoft\u200b\s*Edge)\s*$/i

function normalizeTitle(raw) {
  let t = String(raw ?? '').replace(INVISIBLE_RE, '').replace(/\u00a0/g, ' ')
  t = t.replace(TABBED_SUFFIX_RE, ' ')
  let changed = true
  let guard = 0
  while (changed && guard < 10) {
    changed = false
    guard += 1
    const before = t
    t = t.replace(BROWSER_TAIL_RE, '')
    for (const suf of TITLE_SUFFIXES) {
      if (t.endsWith(suf)) {
        t = t.slice(0, -suf.length).trim()
        changed = true
      }
    }
    // 循环剥完浏览器名后，可能又暴露「- 用户配置」等尾巴
    t = t.replace(TABBED_SUFFIX_RE, ' ').trim()
    t = t.replace(/\s+[-–—]\s*$/, '').trim()
    if (t === before) break
  }
  return t.replace(/\s+/g, ' ').trim()
}

function sanitizeSubject(s) {
  return String(s || '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').slice(0, 60) || '未分类'
}

function mermaidSafe(s) {
  return String(s || '').replace(/[()[\]{}|<>'"`\\/]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
}

function parseJson(text) {
  if (!text) return null
  let t = String(text).trim()
  // 1) 直接解析
  try { return JSON.parse(t) } catch { /* 继续 */ }
  // 2) 剥离 markdown 代码块围栏
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) {
    try { return JSON.parse(fence[1].trim()) } catch { /* 继续 */ }
  }
  // 3) 提取最外层 {} 对象
  const m = t.match(/\{[\s\S]*\}/)
  if (!m) return null
  const candidate = m[0]
  try { return JSON.parse(candidate) } catch { /* 继续 */ }
  // 4) 修复常见 LLM JSON 瑕疵：尾逗号、未加引号的键、单引号字符串值
  try {
    const fixed = candidate
      .replace(/,\s*([}\]])/g, '$1')                                    // 去尾逗号
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')  // 键加引号
      .replace(/:\s*'([^']*)'/g, ':"$1"')                               // 单引号值 → 双引号
    return JSON.parse(fixed)
  } catch { return null }
}

function resolveModel(ctx, config) {
  if (config.provider && config.model) return { provider: config.provider, model: config.model }
  try {
    const sel = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    if (sel && typeof sel.provider === 'string' && typeof sel.model === 'string') {
      return { provider: sel.provider, model: sel.model }
    }
  } catch { /* 忽略 */ }
  try {
    const providers = ctx.llm?.listProviders?.() ?? []
    for (const p of providers) {
      const mid = p.models?.[0]?.id ?? p.defaultModel ?? p.model
      if (p.id && mid) return { provider: p.id, model: mid }
    }
  } catch { /* 忽略 */ }
  return { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
}

// 最近一次 LLM 调用的真实用量（adapter 会在 finish 前发一个 usage chunk）。
// classify / generate 是模块级函数、拿不到插件实例的日志器，所以用一个
// 模块级"信箱"把用量递出来，由 processTitle 读走并写进 poll.log。
let lastUsage = null
const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']

/** 取走上一次调用的用量（读后清空，避免串到下一次）。 */
export function takeUsage() {
  const u = lastUsage
  lastUsage = null
  return u
}

async function callLlm(ctx, config, { system, messages, maxTokens }) {
  const model = resolveModel(ctx, config)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('dsh-course-notes: LLM 调用超时')), 120000)
  try {
    const stream = ctx.llm.stream({
      provider: model.provider,
      model: model.model,
      system,
      messages,
      maxTokens: maxTokens ?? config.maxTokens,
      signal: ac.signal,
    })
    let text = ''
    lastUsage = null
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
        lastUsage = { model: model.model, ...Object.fromEntries(USAGE_FIELDS.map((k) => [k, chunk.usage[k] ?? 0])) }
      }
    }
    return text
  } finally {
    clearTimeout(timer)
  }
}

const userMsg = (text) => ({ role: 'user', id: randomUUID(), content: [{ type: 'text', text }] })

// ---- B 站内容抓取（标题 → 搜索反查 → 视频信息/弹幕/评论） ----
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let cachedBuvid3 = null
async function getBuvid3() {
  if (cachedBuvid3 !== null) return cachedBuvid3
  try {
    const r = await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'User-Agent': BILI_UA } })
    const j = await r.json()
    cachedBuvid3 = j?.data?.b_3 || ''
  } catch { cachedBuvid3 = '' }
  return cachedBuvid3
}

async function biliFetch(url, { json = true, timeoutMs = 10000, retries = 2 } = {}) {
  const buvid3 = await getBuvid3()
  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs)
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': BILI_UA,
          'Referer': 'https://www.bilibili.com/',
          'Accept': 'application/json, text/plain, */*',
          ...(buvid3 ? { Cookie: 'buvid3=' + buvid3 } : {}),
        },
        signal: ac.signal,
      })
      if (res.status === 412) throw new Error('HTTP 412')
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const text = await res.text()
      return json ? JSON.parse(text) : text
    } catch (e) {
      lastErr = e
      if (attempt < retries) await sleep(1500 * (attempt + 1))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr
}

function stripHtml(s) { return String(s || '').replace(/<[^>]+>/g, '').trim() }

function decodeXml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
}

function normTitle(s) { return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '') }

function titleSimilar(a, b) {
  const na = normTitle(a); const nb = normTitle(b)
  if (!na || !nb) return 0
  if (na.includes(nb) || nb.includes(na)) return 1
  const bigrams = (s) => { const m = new Set(); for (let i = 0; i < s.length - 1; i++) m.add(s.slice(i, i + 2)); return m }
  const A = bigrams(na); const B = bigrams(nb)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return (2 * inter) / (A.size + B.size)
}

/** 搜索关键词回退：去掉【】、书名号等装饰标点，避免结构字符干扰搜索。 */
function searchKeywordVariants(title) {
  const raw = String(title ?? '').trim()
  const plain = raw
    .replace(/[【】\[\]《》〈〉「」『』()（）"'"'“”‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const out = [raw]
  if (plain && plain !== raw) out.push(plain)
  // 过长标题截断到前 40 字，避免搜索被整句噪声带偏
  if (raw.length > 40) out.push(raw.slice(0, 40).trim())
  return [...new Set(out.filter(Boolean))]
}

/**
 * 按标题反查 B 站视频。
 *
 * 旧实现只比对搜索结果的第 1 条并且要求相似度 ≥0.5，实测精确匹配的原始
 * 视频经常排在第 3 条（第 1 条是别家的搬运/近似标题），于是直接返回 null，
 * 表现为「bvid=none、弹幕/评论全 0」——内容抓取形同虚设。
 *
 * 新实现：遍历前 20 条，取相似度最高的候选（阈值 0.5）；首轮无命中时
 * 用去装饰标点的关键词再搜一次。
 */
async function searchBili(title) {
  for (const keyword of searchKeywordVariants(title)) {
    const url = 'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' + encodeURIComponent(keyword)
    const data = await biliFetch(url)
    if (data?.code !== 0) throw new Error('bili search code ' + data?.code)
    const results = (data?.data?.result ?? []).filter((r) => r?.bvid)
    if (!results.length) continue
    let best = null
    for (const item of results.slice(0, 20)) {
      const clean = stripHtml(item.title)
      const score = titleSimilar(title, clean)
      if (!best || score > best.score) best = { item, clean, score }
    }
    if (!best || best.score < 0.5) continue
    return {
      bvid: best.item.bvid,
      aid: best.item.aid,
      title: best.clean,
      desc: stripHtml(best.item.description || ''),
      tags: String(best.item.tag || '').split(',').map((s) => s.trim()).filter(Boolean),
    }
  }
  return null
}

async function viewBili(bvid) {
  const data = await biliFetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid))
  if (data?.code !== 0) throw new Error('bili view code ' + data?.code)
  const d = data?.data ?? {}
  return {
    aid: d.aid,
    cid: d.cid ?? d.pages?.[0]?.cid,
    desc: d.desc || '',
    owner: d.owner?.name || '',
    stat: d.stat || {},
    subtitle: d.subtitle?.list ?? [],
  }
}

async function fetchDanmaku(cid) {
  if (!cid) return []
  const xml = await biliFetch('https://comment.bilibili.com/' + cid + '.xml', { json: false })
  const items = []
  const re = /<d[^>]*>([\s\S]*?)<\/d>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    const t = decodeXml(m[1]).trim()
    if (!t) continue
    if (t.startsWith('[') && t.endsWith(']')) continue // 高级弹幕 JSON
    items.push(t)
  }
  const seen = new Set()
  return items.filter((t) => { if (seen.has(t)) return false; seen.add(t); return true }).slice(0, 150)
}

async function fetchComments(aid) {
  if (!aid) return []
  const data = await biliFetch('https://api.bilibili.com/x/v2/reply?type=1&oid=' + aid + '&sort=2&ps=20&pn=1')
  if (data?.code !== 0) throw new Error('bili reply code ' + data?.code)
  return (data?.data?.replies ?? []).map((r) => String(r?.content?.message || '').trim()).filter(Boolean).slice(0, 20)
}

async function fetchSubtitle(view) {
  const list = view?.subtitle ?? []
  if (!list.length) return ''
  let u = list[0]?.subtitle_url
  if (!u) return ''
  if (u.startsWith('//')) u = 'https:' + u
  const data = await biliFetch(u, { json: true })
  return (data?.body ?? []).map((b) => String(b?.content || '').trim()).filter(Boolean).join(' ')
}

// 综合抓取：返回 null 表示未能识别（静默降级为仅标题总结）
async function fetchBiliContent(title) {
  const s = await searchBili(title)
  if (!s) return null
  let view = null
  try { view = await viewBili(s.bvid) } catch { /* 忽略 */ }
  const cid = view?.cid
  const aid = view?.aid || s.aid
  const [danmaku, comments] = await Promise.allSettled([
    cid ? fetchDanmaku(cid) : Promise.resolve([]),
    aid ? fetchComments(aid) : Promise.resolve([]),
  ])
  let transcript = ''
  try { transcript = await fetchSubtitle(view) } catch { /* 忽略 */ }
  return {
    bvid: s.bvid,
    aid,
    cid,
    desc: String(view?.desc || s.desc || '').trim(),
    tags: s.tags || [],
    owner: view?.owner || '',
    stat: view?.stat || {},
    transcript,
    danmaku: danmaku.status === 'fulfilled' ? danmaku.value : [],
    comments: comments.status === 'fulfilled' ? comments.value : [],
  }
}

async function classify(ctx, config, title, existingSubjects, platform = 'unknown') {
  const system = '你是视频内容分类助手。判断一个「浏览器当前标题」是否值得整理成知识地图，并归类到学科。只做知识类课程，娱乐与游戏内容一律不录入。'
  const platformLabel = platform === 'bilibili' ? 'B站' : platform === 'xuexitong' ? '学习通/超星' : '未知平台'
  const user = `浏览器当前标题：${JSON.stringify(title)}
平台：${platformLabel}
已有学科列表：${JSON.stringify(existingSubjects)}

只返回一个合法 JSON 对象（不要任何多余文字、不要 markdown 代码块、不要尾逗号），格式：
{"isCourse":true,"category":"course","subject":"学科名","title":"清洗后的视频标题","keywords":["关键词1","关键词2"]}

category 只能取以下之一：
- "course"：知识类课程/教程/科普/学术等（唯一会被录入的类别）
- "entertainment"：娱乐内容
- "gaming"：游戏内容
- "other"：其它非知识内容（新闻、直播闲聊、普通网页等）

规则（硬性）：
- 娱乐内容一律 isCourse=false、category="entertainment"。包括但不限于：综艺、搞笑/鬼畜/整活、短剧、明星八卦、影视解说与混剪、动漫、吃播、音乐MV、纯音乐、情感区、生活vlog、开箱娱乐向、宠物、颜值、段子。
- 游戏内容一律 isCourse=false、category="gaming"。包括但不限于：游戏实况、游戏攻略、游戏直播录像、解说、游戏剧情剪辑、游戏评测、开箱、手游/端游娱乐向内容。
- 唯一例外：面向开发的「游戏开发」教学（如 Unity/Unreal 引擎编程教程、图形学、游戏引擎架构）算知识课程，isCourse=true、category="course"、学科归到「游戏开发」或「图形学」等；单纯玩游戏、看别人玩、游戏资讯/评测一律不算。
- 其它无知识含量内容 isCourse=false：新闻播报、直播聊天、普通网页、搜索页、社交页、邮箱、工作软件等，category="other"。
- isCourse 填 true 的「有知识含量」内容：课程、教程、教学、科普、纪录片、学术讲座、技能讲解、历史/文化/科技解读、深度测评（有技术含量的硬件/工具测评）等。
- 若该视频属于已有学科之一，subject 必须与列表里某个已有名字完全一致；否则给一个简洁的新学科名（中文，≤8 字，如 机器学习/前端开发/英语/历史/数学/算法/美食测评）。
- title 为去掉浏览器与平台后缀后的纯视频标题。
- keywords 为 3~6 个核心知识点关键词（非课程可留空数组）。`
  let text = await callLlm(ctx, config, { system, messages: [userMsg(user)], maxTokens: 700 })
  let cls = parseJson(text)
  if (!cls) {
    // 解析失败重试一次：强调只输出合法 JSON
    const retry = user + '\n\n（注意：上一次你的回复无法被解析。请严格只输出一个合法 JSON 对象本身，前后不要任何解释文字、不要 markdown 代码块、不要尾逗号。）'
    text = await callLlm(ctx, config, { system, messages: [userMsg(retry)], maxTokens: 700 })
    cls = parseJson(text)
  }
  return cls
}

/**
 * 非知识类判定（程序侧兜底，不只依赖 LLM 是否老实）。
 *
 * 娱乐 / 游戏 / 其它 → 一律不录入：不生成知识地图、不建会话、静默记 seen。
 * 这里以模型自己返回的 category 为准做确定性判定，避免「模型说 category
 * 是 gaming 但仍填了 isCourse:true」时被误录入。
 */
function isNonKnowledge(cls) {
  if (!cls || typeof cls !== 'object') return false
  const category = String(cls.category ?? '').trim().toLowerCase()
  if (category === 'entertainment' || category === 'gaming' || category === 'other') return true
  return cls.isCourse === false
}

async function generate(ctx, config, { title, subject, keywords, content, platform = 'bilibili' }) {
  const system = '你是学习笔记整理专家，为视频课程生成「知识地图」（Markdown + Mermaid 思维导图）。'
  const safeTitle = mermaidSafe(title)
  let srcBlock = ''
  if (content) {
    const parts = []
    if (content.desc) parts.push('【视频简介】\n' + content.desc.slice(0, 800))
    if (content.tags?.length) parts.push('【视频标签】\n' + content.tags.join('、'))
    if (content.transcript) parts.push('【字幕/讲解文本（节选）】\n' + content.transcript.slice(0, 1500))
    if (content.danmaku?.length) parts.push('【弹幕（节选 ' + content.danmaku.length + ' 条）】\n' + content.danmaku.slice(0, 120).join('\n'))
    if (content.comments?.length) parts.push('【评论区热评（节选 ' + content.comments.length + ' 条）】\n' + content.comments.slice(0, 20).join('\n'))
    if (parts.length) srcBlock = '\n\n已抓取到以下视频真实内容/弹幕/评论，请基于它们总结（不要凭空编造）：\n\n' + parts.join('\n\n')
  }
  // 只有 B 站且确实抓到了弹幕/评论，才输出「弹幕与评论讨论焦点」；学习通
  // 没有公开互动数据，用「学习建议」替代，避免模型编造观众评论。
  const hasAudience = Array.isArray(content?.danmaku) && content.danmaku.length > 0
    || Array.isArray(content?.comments) && content.comments.length > 0
  const thirdSection = hasAudience
    ? '### 弹幕与评论讨论焦点\n- 观众关注/讨论的重点（1~3 条）'
    : '### 学习建议\n- 该知识点的常见误区 / 推荐练习（1~3 条）'
  const sourceRule = content
    ? '优先基于抓取到的简介/字幕/弹幕/评论提炼真实知识点，不要编造。'
    : (platform === 'xuexitong'
      ? '平台（学习通/超星）没有可抓取的公开内容，只能依据标题与学科给出课程结构化的通用知识框架；不得虚构具体章节编号、教师原话或数据，措辞上用「通常/一般/该知识点包括」这类概括表述。'
      : '基于标题与关键词合理推断、通用化。')
  const user = `视频标题：${title}
学科：${subject}
关键词：${keywords.join('、')}${srcBlock}

只返回 Markdown（不要任何解释、不要首尾多余说明），结构如下：

## ${title}

> 一句话简介（概括本视频核心内容）

### 核心知识点
- **主题一**
  - 要点
  - 要点

${thirdSection}

### 思维导图
\`\`\`mermaid
mindmap
  root((${safeTitle}))
    ...
\`\`\`

要求：${sourceRule}全部用中文；知识点 8~20 条、分 2~3 层；mermaid 用 mindmap 语法、2~3 层、节点文字避免括号等特殊字符。`
  return await callLlm(ctx, config, { system, messages: [userMsg(user)], maxTokens: config.maxTokens })
}

// 插件自身目录（file: 安装后整个目录被复制，scripts/md2docx.py 就在其中）
// 本插件目录与工作区目录（file:/link: 安装后 lib/ 与 scripts/ 都在插件目录内）
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const MD2DOCX_PATH = join(PLUGIN_DIR, 'scripts', 'md2docx.py')
// 工作区 = 插件目录的父目录（插件位于 <工作区>/dsh-course-notes/ 下）
const WORKSPACE_DIR = dirname(PLUGIN_DIR)

/** 找一个可用的 Python（优先 DSH 捆绑运行时，其次 PATH）。 */
function findPython() {
  const cands = []
  const runtimesDir = join(homedir(), '.dsh', 'dsh-runtimes')
  try {
    for (const rt of readdirSync(runtimesDir)) {
      cands.push(join(runtimesDir, rt, 'dependencies', 'python', 'python.exe'))
    }
  } catch { /* 忽略 */ }
  cands.push('python', 'python3')
  for (const c of cands) {
    try {
      const r = spawnSync(c, ['--version'], { timeout: 8000, windowsHide: true })
      if (r.status === 0) return c
    } catch { /* 忽略 */ }
  }
  return 'python'
}

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  ensureDir(config.outputDir)
  const stateDir = join(config.outputDir, '.state')
  ensureDir(stateDir)
  const statePath = join(stateDir, 'state.json')
  const ps1Path = join(stateDir, 'poll.ps1')
  const pollOutPath = join(stateDir, 'poll-out.txt')
  const manualsDir = join(stateDir, 'manuals')
  ensureDir(manualsDir)
  const pythonPath = findPython()
  writeFileSync(ps1Path, POLL_PS1, 'utf8')

  const state = loadState(statePath)
  if (!state.subjects || typeof state.subjects !== 'object') state.subjects = {}
  if (!state.seen || typeof state.seen !== 'object') state.seen = {}
  if (!state.seenAttempts || typeof state.seenAttempts !== 'object') state.seenAttempts = {}
  if (!state.skipped || typeof state.skipped !== 'object') state.skipped = {}
  if (typeof state.lastTitle !== 'string') state.lastTitle = ''
  if (typeof state.lastRunAt !== 'number') state.lastRunAt = 0
  if (typeof state.lastDeliveredAt !== 'number') state.lastDeliveredAt = 0
  if (typeof state.lastDeliveredSession !== 'string') state.lastDeliveredSession = ''

  // 调试日志：写到 .state/poll.log，便于排查「为何没生成」
  const logPath = join(stateDir, 'poll.log')
  function logLine(msg) {
    try { appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, 'utf8') } catch { /* 忽略 */ }
  }
  let lastLogKey = ''
  function logObservation(proc, title) {
    const key = `${proc}|${title}`
    if (key === lastLogKey) return
    lastLogKey = key
    logLine(`fg proc=${proc} title=${JSON.stringify(title)}`)
  }

  let pending = null   // { title, count } — 稳定性去抖
  let running = false  // 处理中互斥
  let pollFailures = 0 // 连续读取前台窗口失败次数（仅用于日志提示）
  let lastClassifyAt = 0 // 上次 LLM 分类时间戳（节流用）
  const classifyLog = [] // 最近分类时间戳（每小时上限用）

  /** 分类节流：返回 null 表示允许，否则返回拒绝原因。 */
  function classifyThrottle() {
    const now = Date.now()
    if (now - lastClassifyAt < config.minClassifyGapMs) return 'too-soon'
    const cutoff = now - 3600_000
    while (classifyLog.length > 0 && classifyLog[0] < cutoff) classifyLog.shift()
    if (classifyLog.length >= config.maxClassifyPerHour) return 'hourly-limit'
    return null
  }

  async function pollForeground() {
    try {
      await execFileP('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', ps1Path, '-OutFile', pollOutPath,
      ], { timeout: 8000, windowsHide: true })
      const txt = readFileSync(pollOutPath, 'utf8').replace(/^\uFEFF/, '')
      const title = (txt.match(/^TITLE=(.*)$/m)?.[1] ?? '').trim()
      const proc = (txt.match(/^PROC=(.*)$/m)?.[1] ?? '').trim()
      return { title, proc }
    } catch { return null }
  }

  function isBrowserProc(proc) {
    return BROWSER_PROCESSES.has(String(proc || '').toLowerCase().replace(/\.exe$/i, ''))
  }

  const subjectDir = (subject) => join(config.outputDir, subject)
  const manualMdPath = (subject) => join(manualsDir, `${subject}.md`)             // 内部 Markdown 源
  const manualDocxPath = (subject) => join(subjectDir(subject), '学习手册.docx')   // 对外 Word 文档
  const indexMdPath = () => join(manualsDir, 'index.md')

  function createSubjectManual(subject) {
    const header = `# ${subject} 学习手册\n\n<!-- OVERVIEW_START -->\n## 学科总览\n\`\`\`mermaid\nmindmap\n  root((${mermaidSafe(subject)}))\n\`\`\`\n<!-- OVERVIEW_END -->\n`
    atomicWrite(manualMdPath(subject), header)
  }

  function buildOverviewBlock(subject) {
    const videos = state.subjects[subject]?.videos ?? []
    const lines = ['```mermaid', 'mindmap', `  root((${mermaidSafe(subject)}))`]
    for (const v of videos) lines.push(`    ${mermaidSafe(v)}`)
    lines.push('```')
    return `<!-- OVERVIEW_START -->\n## 学科总览\n${lines.join('\n')}\n<!-- OVERVIEW_END -->`
  }

  function regenerateOverview(subject) {
    const p = manualMdPath(subject)
    let text = readFileSync(p, 'utf8')
    const start = text.indexOf('<!-- OVERVIEW_START -->')
    const end = text.indexOf('<!-- OVERVIEW_END -->')
    if (start === -1 || end === -1) return
    text = text.slice(0, start) + buildOverviewBlock(subject) + text.slice(end + '<!-- OVERVIEW_END -->'.length)
    atomicWrite(p, text)
  }

  function appendVideo(subject, title, md) {
    const p = manualMdPath(subject)
    const text = readFileSync(p, 'utf8').replace(/\s+$/, '') + `\n\n---\n\n${md}\n`
    atomicWrite(p, text)
  }

  // ---- 单视频 Word 笔记（投递物） ----
  const safeFileName = (s) => String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '未命名课程'
  const videoMdPath = (subject, title) => join(manualsDir, 'videos', safeFileName(subject), `${safeFileName(title)}.md`)
  const videoDocxPath = (subject, title) => join(subjectDir(subject), `${safeFileName(title)}.docx`)

  /**
   * 把单个视频的 Markdown 落成独立 Word。失败时保留 .md 并返回
   * { docxPath: null, mdPath }，由调用方降级为投递 .md，不阻断流程。
   */
  function writeVideoDocx(subject, title, md) {
    const mdPath = videoMdPath(subject, title)
    atomicWrite(mdPath, `# ${title}\n\n${md}\n`)
    if (!config.perVideoDocx) return { docxPath: null, mdPath }
    const docxPath = videoDocxPath(subject, title)
    try {
      convertToDocx(mdPath, docxPath)
      return { docxPath, mdPath }
    } catch (error) {
      logLine(`video docx error subject=${JSON.stringify(subject)} title=${JSON.stringify(title)} msg=${error?.message ?? error}`)
      return { docxPath: null, mdPath }
    }
  }

  // ---- 投递层：新建会话 + 把 Word 以文件卡送进对话框 ----
  const deliveryLog = [] // 最近投递时间戳，用于每小时限流
  function deliveriesInLastHour() {
    const cutoff = Date.now() - 3600_000
    while (deliveryLog.length > 0 && deliveryLog[0] < cutoff) deliveryLog.shift()
    return deliveryLog.length
  }

  function resolveDeliverModel() {
    if (config.deliverProvider && config.deliverModel) {
      return { provider: config.deliverProvider, model: config.deliverModel }
    }
    try {
      const sel = ctx.get?.('agentDefaultModel')?.currentSelection?.()
      if (sel && typeof sel.provider === 'string' && typeof sel.model === 'string') {
        return { provider: sel.provider, model: sel.model }
      }
    } catch { /* 忽略 */ }
    return resolveModel(ctx, config)
  }

  async function resolveAgentPreset(agentPresets) {
    if (!agentPresets || typeof agentPresets.resolve !== 'function' || typeof agentPresets.mount !== 'function') return null
    try {
      const resolved = await agentPresets.resolve(undefined)
      const id = String(resolved?.id ?? '').trim()
      if (!id) return null
      return { id, mount: async (agentCtx) => { await agentPresets.mount(agentCtx, id) } }
    } catch (error) {
      logLine(`agentPresets resolve error msg=${error?.message ?? error}`)
      return null
    }
  }

  /**
   * 新建一个会话并把 Word 笔记投递进它的对话框。
   *
   * 为什么必须建会话：present 交付卡片与文件卡只在「一轮对话结束」时渲染，
   * 无法从插件侧直接推送到已有会话或凭空显示。所以这里复用 DSH GUI 新建
   * 会话的同一条路径（agents.create），再把 docx 作为用户消息附件投递。
   */
  async function deliverVideoNote({ subject, title, docxPath, mdPath, summaryLine }) {
    if (!config.deliver) return { ok: false, skipped: 'disabled' }
    if (deliveriesInLastHour() >= config.maxDeliveriesPerHour) {
      logLine(`deliver skipped: 已达每小时上限 ${config.maxDeliveriesPerHour}`)
      return { ok: false, skipped: 'rate-limited' }
    }
    const agents = ctx.get?.('agents')
    if (!agents || typeof agents.create !== 'function') {
      return { ok: false, skipped: 'agents-unavailable' }
    }
    const attachPath = docxPath ?? mdPath
    if (!attachPath || !existsSync(attachPath)) {
      return { ok: false, skipped: 'no-file' }
    }

    const model = resolveDeliverModel()
    const agentPresets = ctx.get?.('agentPresets')
    const preset = await resolveAgentPreset(agentPresets)
    const sessionId = `session-${randomUUID()}`
    let handle = null
    try {
      handle = await agents.create({
        sessionId,
        ...(model.provider && model.model ? { agentOptions: { provider: model.provider, model: model.model } } : {}),
        meta: {
          cwd: WORKSPACE_DIR,
          ...(preset ? { agentPreset: preset.id } : {}),
        },
        ...(preset ? { setup: preset.mount } : {}),
      })
    } catch (error) {
      logLine(`deliver create session error title=${JSON.stringify(title)} msg=${error?.message ?? error}`)
      return { ok: false, skipped: 'create-failed' }
    }

    try {
      // cordis 服务必须通过 ctx.get 取；直接属性访问未注入的服务会抛
      // 「cannot get property ... without inject」。sessionTitle 只用于
      // 给会话起个可读名字，取不到就跳过，不影响交付。
      const sessionTitle = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined
      if (sessionTitle && typeof sessionTitle.rename === 'function' && handle?.agent?.session) {
        try { sessionTitle.rename(handle.agent.session, `课程笔记｜${title}`.slice(0, 80)) } catch { /* 忽略 */ }
      }

      let content = [{ type: 'text', text: buildDeliveryText({ subject, title, attachPath, summaryLine, kind: docxPath ? 'docx' : 'md', mode: config.deliverMode }) }]
      const attachments = ctx.get?.('attachments')
      if (docxPath && attachments && typeof attachments.saveFile === 'function') {
        try {
          const data = readFileSync(docxPath)
          const ref = await attachments.saveFile({ data, name: `${safeFileName(title)}.docx` })
          content = [{ type: 'file', attachment: ref }, ...content]
        } catch (error) {
          logLine(`deliver saveFile error title=${JSON.stringify(title)} msg=${error?.message ?? error}`)
        }
      }

      const message = {
        role: 'user',
        id: randomUUID(),
        content,
        source: { kind: 'user' },
      }
      if (config.deliverMode === 'append') {
        // 零 token：直接写入会话表面（用户消息 + 文件卡），不触发模型回合。
        // 客户端会把这条消息渲染成「用户气泡 + Word 文件卡」，但没有
        // present 交付卡片，也不会写记忆。
        const session = handle?.agent?.session
        if (!session || typeof session.append !== 'function') {
          logLine(`deliver append unavailable，回退 followup title=${JSON.stringify(title)}`)
          handle.agent.followup(message)
        } else {
          session.append('user/message', message, { surfaceOp: 'append' })
        }
      } else {
        handle.agent.followup(message)
      }

      deliveryLog.push(Date.now())
      state.lastDeliveredAt = Date.now()
      state.lastDeliveredSession = sessionId
      saveState(statePath, state)
      logLine(`delivered mode=${config.deliverMode} title=${JSON.stringify(title)} session=${sessionId} file=${attachPath}`)
      return { ok: true, sessionId, file: attachPath, mode: config.deliverMode }
    } catch (error) {
      logLine(`deliver error title=${JSON.stringify(title)} msg=${error?.message ?? error}`)
      return { ok: false, skipped: 'deliver-failed' }
    }
  }

  function buildDeliveryText({ subject, title, attachPath, summaryLine, kind, mode }) {
    const head = [
      `📚 ${title}`,
      '',
      `- 学科：${subject}`,
      `- 文件：${attachPath}`,
      ...(config.deliverSummary && summaryLine ? ['', summaryLine] : []),
      ...(kind === 'md' ? ['', '（Word 转换失败，本次交付 Markdown 源文件。）'] : []),
    ]
    // append 模式没有模型回合，这条消息是给人看的，不写任何指令。
    if (mode === 'append') return head.join('\n')
    return [
      '这是刚自动检测到的视频课程笔记，已经生成完毕。',
      '',
      ...head.slice(2),
      '',
      '只需做三件事，不要做别的：',
      '1. 调用 present 交付上面这个文件（kind=md 时交付 md）。',
      '2. 如果本会话有 memory 工具：用它把该视频的 3~5 条核心要点写入长期记忆（学科：' + subject + '）。',
      '   如果没有 memory 工具：跳过这一步即可，**不要**用 edit/写文件的方式改记忆文件。',
      '3. 用一两句话回复要点，收尾即可。',
      '',
      '禁止：探索或列出目录、读取源码、执行命令、修改工作区或记忆目录里的任何文件、重复总结文档。',
    ].join('\n')
  }

  // 用捆绑 Python + python-docx 把 Markdown 转成 Word（.docx）
  function convertToDocx(mdPath, docxPath) {
    ensureDir(dirname(docxPath))
    const r = spawnSync(pythonPath, [MD2DOCX_PATH, mdPath, docxPath], { timeout: 60000, windowsHide: true, encoding: 'utf8' })
    if (r.status !== 0) {
      throw new Error(`md2docx 转换失败（${pythonPath}）：${String(r.stderr || r.stdout || '').trim().slice(0, 500)}`)
    }
  }

  function convertSubject(subject) {
    convertToDocx(manualMdPath(subject), manualDocxPath(subject))
  }

  function regenerateIndex() {
    const subjects = Object.keys(state.subjects)
    const lines = ['# 视频课程知识地图', '', `> 自动生成 · 最后更新 ${new Date().toLocaleString('zh-CN', { hour12: false })}`, '', '## 学科总览', '```mermaid', 'mindmap', '  root((课程知识地图))']
    for (const s of subjects) lines.push(`    ${mermaidSafe(s)}`)
    lines.push('```', '', '## 学科列表')
    if (subjects.length === 0) lines.push('（暂无，开始观看视频课程后会自动生成）')
    for (const s of subjects) {
      const n = state.subjects[s]?.videos?.length ?? 0
      lines.push(`- ${s} — ${n} 个视频 → 「${s}/学习手册.docx」`)
    }
    lines.push('')
    const mdPath = indexMdPath()
    atomicWrite(mdPath, lines.join('\n'))
    convertToDocx(mdPath, join(config.outputDir, '课程总览.docx'))
  }

  // 启动时：迁移旧版 .md 源（<subject>/学习手册.md → .state/manuals/），并为已有学科重新生成 Word
  function migrateLegacyMd(subject) {
    const newPath = manualMdPath(subject)
    if (existsSync(newPath)) return
    const oldPath = join(subjectDir(subject), '学习手册.md')
    if (existsSync(oldPath)) {
      ensureDir(dirname(newPath))
      renameSync(oldPath, newPath)
    }
  }
  try {
    for (const subject of Object.keys(state.subjects)) {
      migrateLegacyMd(subject)
      convertSubject(subject)
    }
    if (Object.keys(state.subjects).length > 0) regenerateIndex()
  } catch (error) {
    logLine(`startup docx error msg=${error?.message ?? error}`)
    console.error('[dsh-course-notes] 启动时生成 Word 失败：', error)
  }

  async function processTitle(title, platform = 'unknown', { throttle = true } = {}) {
    if (running) return { outcome: 'busy' }
    running = true
    try {
      if (throttle) {
        const blocked = classifyThrottle()
        if (blocked) {
          logLine(`classify throttled reason=${blocked} title=${JSON.stringify(title)}`)
          return { outcome: 'throttled', reason: blocked }
        }
      }
      lastClassifyAt = Date.now()
      classifyLog.push(lastClassifyAt)
      const existing = Object.keys(state.subjects)
      const cls = await classify(ctx, config, title, existing, platform)
      const classifyUsage = takeUsage()
      if (classifyUsage) logLine(`usage classify ${JSON.stringify(classifyUsage)}`)
      logLine(`classify platform=${platform} title=${JSON.stringify(title)} result=${JSON.stringify(cls)}`)
      if (!cls) {
        // 分类失败（LLM 超时/JSON 不可解析）：计数重试，超过上限才记入 seen，
        // 避免同一坏标题每个轮询都重复烧 token。
        const attempts = (state.seenAttempts?.[title] ?? 0) + 1
        if (!state.seenAttempts) state.seenAttempts = {}
        state.seenAttempts[title] = attempts
        if (attempts >= config.maxSeenAttempts) {
          state.seen[title] = Date.now()
          delete state.seenAttempts[title]
          logLine(`classify 连续失败 ${attempts} 次，记入 seen 不再重试 title=${JSON.stringify(title)}`)
        }
        state.lastTitle = title
        pruneSeen()
        saveState(statePath, state)
        return { outcome: 'classify-failed', attempts }
      }
      if (isNonKnowledge(cls)) {
        // 娱乐 / 游戏 / 其它非知识内容：静默忽略，只记 seen 不重复判定。
        const category = String(cls?.category ?? (cls?.isCourse === false ? 'other' : '')).trim() || 'unknown'
        logLine(`skip non-knowledge category=${category} title=${JSON.stringify(title)}`)
        state.seen[title] = Date.now()
        if (state.seenAttempts) delete state.seenAttempts[title]
        state.lastTitle = title
        if (!state.skipped || typeof state.skipped !== 'object') state.skipped = {}
        state.skipped[category] = (state.skipped[category] ?? 0) + 1
        pruneSeen()
        saveState(statePath, state)
        return { outcome: 'skipped-nonknowledge', category }
      }
      const subject = sanitizeSubject(cls.subject)
      const clean = String(cls.title || title).trim() || title
      const keywords = (Array.isArray(cls.keywords) ? cls.keywords : []).map(String).filter(Boolean)
      // 抓取真实内容：仅 B 站有公开接口；学习通/未知平台降级为「标题+学科」
      // 推断式总结（明确不编造事实，见 generate 的 system 约束）。
      let content = null
      if (platform === 'xuexitong') {
        logLine(`content skip platform=xuexitong（无公开内容接口，降级标题级总结） title=${JSON.stringify(clean)}`)
      } else if (config.fetchContent) {
        try {
          content = await fetchBiliContent(clean)
          if (content?.tags?.length) {
            for (const t of content.tags) if (t && !keywords.includes(t) && keywords.length < 10) keywords.push(t)
          }
          logLine(`bili content title=${JSON.stringify(clean)} bvid=${content?.bvid ?? 'none'} danmaku=${content?.danmaku?.length ?? 0} comments=${content?.comments?.length ?? 0} transcript=${content?.transcript?.length || 0}`)
        } catch (e) {
          logLine(`bili fetch error title=${JSON.stringify(clean)} msg=${e?.message ?? e}`)
        }
      }
      const md = await generate(ctx, config, { title: clean, subject, keywords, content, platform })
      const generateUsage = takeUsage()
      if (generateUsage) logLine(`usage generate ${JSON.stringify(generateUsage)}`)
      // 累计用量，供 status 展示「平均每视频花多少 token」
      if (!state.usage || typeof state.usage !== 'object') state.usage = {}
      for (const [phase, u] of [['classify', classifyUsage], ['generate', generateUsage]]) {
        if (!u) continue
        const acc = state.usage[phase] ?? { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
        acc.calls += 1
        acc.inputTokens += u.inputTokens || 0
        acc.outputTokens += u.outputTokens || 0
        acc.cacheReadTokens += u.cacheReadTokens || 0
        state.usage[phase] = acc
      }
      state.usage.videos = (state.usage.videos ?? 0) + 1
      const isNew = !state.subjects[subject]
      if (isNew) {
        state.subjects[subject] = { createdAt: Date.now(), videos: [] }
        createSubjectManual(subject)
      }
      appendVideo(subject, clean, md)
      if (!state.subjects[subject].videos.includes(clean)) state.subjects[subject].videos.push(clean)
      regenerateOverview(subject)
      convertSubject(subject)
      regenerateIndex()

      // 单视频 Word → 投递到新建会话（失败只影响交付，不影响知识地图）
      let delivery = { ok: false, skipped: 'not-attempted' }
      try {
        const { docxPath, mdPath } = writeVideoDocx(subject, clean, md)
        delivery = await deliverVideoNote({
          subject,
          title: clean,
          docxPath,
          mdPath,
          summaryLine: `核心知识点：${keywords.slice(0, 6).join('、')}`,
        })
      } catch (error) {
        logLine(`video deliver error title=${JSON.stringify(clean)} msg=${error?.message ?? error}`)
      }

      state.seen[title] = Date.now()
      if (state.seenAttempts) delete state.seenAttempts[title]
      state.lastTitle = title
      state.lastRunAt = Date.now()
      pruneSeen()
      saveState(statePath, state)
      console.log(`[dsh-course-notes] ${isNew ? '新学科' : '更新学科'}「${subject}」 ← ${clean}（投递：${delivery.ok ? delivery.sessionId : '未投递/' + delivery.skipped}）`)
      return {
        outcome: 'processed',
        subject,
        cleanTitle: clean,
        isNewSubject: isNew,
        delivery,
      }
    } catch (error) {
      logLine(`error title=${JSON.stringify(title)} msg=${error?.message ?? error}`)
      console.error('[dsh-course-notes] 处理失败（不影响后续轮询）：', error)
      return { outcome: 'error', message: String(error?.message ?? error) }
    } finally {
      running = false
    }
  }

  function pruneSeen() {
    const keys = Object.keys(state.seen)
    if (keys.length <= 500) return
    const sorted = keys.sort((a, b) => (state.seen[a] ?? 0) - (state.seen[b] ?? 0))
    for (const k of sorted.slice(0, keys.length - 500)) delete state.seen[k]
  }

  async function observeOnce() {
    if (!config.enabled) return
    const fg = await pollForeground()
    if (!fg) {
      pollFailures += 1
      if (pollFailures === 3) logLine('warn: 连续 3 次读取前台窗口失败（轮询仍在继续）')
      return
    }
    pollFailures = 0
    logObservation(fg.proc, fg.title)
    if (!isBrowserProc(fg.proc)) return
    const title = cleanTitle(fg.title)
    if (title.length < config.titleMinLen) return
    // 只跳过「以平台名开头」的通用页（B 站首页/搜索页/分类页），
    // 只跳过「以平台名开头」的通用页（首页/搜索页/分类页/登录页），
    // 不能跳过任何"包含"平台名的标题——视频标题常以 _哔哩哔哩_bilibili 结尾。
    if (/^(哔哩哔哩|bilibili)/i.test(title)) return
    if (/^(学习通|超星学习通|超星|学堂在线|智慧树|知到|中国大学MOOC|登录|用户登录|统一身份认证)$/i.test(title)) return
    if (Object.hasOwn(state.seen, title)) { pending = null; return }
    const platform = detectPlatform(fg.title, title)
    // 省钱护栏：非已知视频/课程平台的页面（GitHub、搜索页、文档站…）
    // 直接静默跳过，绝不调用模型。
    if (shouldSkipByPlatform(platform, config.onlyKnownPlatforms)) {
      pending = null
      if (!state.skipped || typeof state.skipped !== 'object') state.skipped = {}
      state.skipped['unknown-platform'] = (state.skipped['unknown-platform'] ?? 0) + 1
      logLine(`skip unknown platform cleaned=${JSON.stringify(title)}`)
      saveState(statePath, state)
      return
    }
    logLine(`browser proc=${fg.proc} platform=${platform} cleaned=${JSON.stringify(title)}`)
    if (!pending || pending.title !== title) pending = { title, platform, count: 1 }
    else pending.count += 1
    if (pending.count >= config.stablePolls) {
      const t = pending.title
      const p = pending.platform
      pending = null
      await processTitle(t, p)
    }
  }

  // 状态查看工具
  ctx.effect(() => ctx.tools.register({
    name: 'course_map_status',
    description: '查看「课程实时笔记助手（B站/学习通）」的运行状态：是否启用、输出目录、已分类学科与视频数、最近观察到的标题、最近一次投递的会话。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean' }, enabled: { type: 'boolean' },
          outputDir: { type: 'string' }, lastTitle: { type: 'string' },
          lastRunAt: { type: 'integer' },
          lastDeliveredAt: { type: 'integer' },
          lastDeliveredSession: { type: 'string' },
          deliver: { type: 'boolean' },
          subjects: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { subject: { type: 'string' }, videos: { type: 'integer' } }, required: ['subject', 'videos'] } },
          message: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message ?? '' }],
    },
    async execute() {
      const subjects = Object.entries(state.subjects).map(([subject, d]) => ({ subject, videos: d.videos?.length ?? 0 }))
      const message = [
        '课程实时笔记助手状态：',
        `- 启用：${config.enabled}`,
        `- 输出目录：${config.outputDir}`,
        `- 新建会话投递：${config.deliver ? `开启（模式=${config.deliverMode}${config.deliverMode === 'append' ? '，零 token 不跑模型' : '，会跑一轮模型'}，每小时上限 ${config.maxDeliveriesPerHour}，本进程近 1 小时已投递 ${deliveriesInLastHour()}）` : '关闭'}`,
        `- 学科数：${subjects.length}`,
        ...subjects.map((s) => `  · ${s.subject}（${s.videos} 个视频）`),
        `- 静默忽略（娱乐/游戏/其它）：${Object.entries(state.skipped ?? {}).map(([k, v]) => `${k}=${v}`).join('，') || '无'}`,
        `- 省钱护栏：仅已知平台=${config.onlyKnownPlatforms}，分类最小间隔 ${Math.round(config.minClassifyGapMs / 1000)}s，每小时分类上限 ${config.maxClassifyPerHour}（本进程近 1 小时已分类 ${classifyLog.length}）`,
        `- 累计用量（处理 ${state.usage?.videos ?? 0} 个视频）：${(() => {
          const u = state.usage ?? {}
          const fmt = (k) => {
            const a = u[k]
            if (!a || !a.calls) return `${k}=0`
            const avgIn = Math.round(a.inputTokens / a.calls)
            const avgOut = Math.round(a.outputTokens / a.calls)
            return `${k}=${a.calls}次/输入${a.inputTokens}(均${avgIn})/输出${a.outputTokens}(均${avgOut})/缓存读${a.cacheReadTokens}`
          }
          return [fmt('classify'), fmt('generate')].join('；')
        })()}`,
        `- 最近观察：${state.lastTitle || '（无）'}`,
        `- 最近投递：${state.lastDeliveredAt ? `${new Date(state.lastDeliveredAt).toLocaleString('zh-CN', { hour12: false })} → ${state.lastDeliveredSession || '（未知会话）'}` : '（无）'}`,
      ].join('\n')
      return {
        ok: true, enabled: config.enabled, outputDir: config.outputDir,
        lastTitle: state.lastTitle, lastRunAt: state.lastRunAt,
        lastDeliveredAt: state.lastDeliveredAt, lastDeliveredSession: state.lastDeliveredSession,
        deliver: config.deliver, subjects, message,
      }
    },
  }), 'dsh-course-notes: status tool')

  // 手动扫描工具
  ctx.effect(() => ctx.tools.register({
    name: 'course_map_scan',
    description: '立即执行一次前台窗口观察与知识地图生成（B站与学习通，绕过轮询间隔，便于测试或手动触发）；可传 title 直接指定要处理的视频标题，force=true 时即使该标题已处理过也会重新生成。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '可选：直接指定要处理的视频标题（跳过前台窗口读取，便于测试/手动输入）' },
        platform: { type: 'string', enum: ['bilibili', 'xuexitong'], description: '可选：强制平台（bilibili=抓弹幕/评论；xuexitong=降级标题级总结）。不传则按标题自动识别' },
        force: { type: 'boolean', description: '可选：true=忽略去重表强制重新生成（默认 false，已处理过则跳过）' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          skipped: { type: 'string' },
          sessionId: { type: 'string', description: '投递成功后新建的会话 id' },
        },
        required: ['ok'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message ?? '' }],
    },
    async execute(args) {
      if (!config.enabled) return { ok: false, message: 'Agent 未启用（config.enabled=false）' }
      let title = null
      let platform = 'unknown'
      if (args && typeof args.title === 'string' && args.title.trim()) {
        title = cleanTitle(args.title)
        platform = detectPlatform(args.title, title)
        if (args.platform === 'bilibili' || args.platform === 'xuexitong') platform = args.platform
      } else {
        const fg = await pollForeground()
        if (!fg) return { ok: false, message: '无法读取前台窗口' }
        if (!isBrowserProc(fg.proc)) return { ok: false, message: `前台窗口不是浏览器/视频客户端（进程 ${fg.proc || '未知'}）：${fg.title}` }
        title = cleanTitle(fg.title)
        platform = detectPlatform(fg.title, title)
      }
      if (!title) return { ok: false, message: '标题为空（清洗后无有效内容）' }
      const force = args?.force === true
      if (Object.hasOwn(state.seen, title) && !force) {
        return { ok: true, skipped: 'seen', message: `「${title}」已处理过（静默跳过）。需要重新生成请传 force=true。` }
      }
      if (force) {
        delete state.seen[title]
        if (state.seenAttempts) delete state.seenAttempts[title]
        saveState(statePath, state)
      }
      // 若另有处理在进行，等待其结束（最多 90 秒），避免被静默丢弃
      let waited = 0
      while (running && waited < 90000) { await sleep(1000); waited += 1000 }
      const result = await processTitle(title, platform, { throttle: false })
      const head = `「${title}」（平台：${platform}）`
      if (result?.outcome === 'skipped-nonknowledge') {
        return { ok: true, skipped: result.category, message: `${head} 属非知识内容（${result.category}），已静默忽略：不生成知识地图、不新建会话。` }
      }
      if (result?.outcome === 'classify-failed') {
        return { ok: false, skipped: 'classify-failed', message: `${head} 分类失败（第 ${result.attempts} 次），已记录，稍后自动重试。` }
      }
      if (result?.outcome === 'busy') {
        return { ok: false, skipped: 'busy', message: '另一个视频正在处理中，本次未执行。' }
      }
      if (result?.outcome === 'throttled') {
        return { ok: false, skipped: 'throttled', message: `分类被节流（${result.reason}），本次未执行。` }
      }
      if (result?.outcome === 'error') {
        return { ok: false, skipped: 'error', message: `${head} 处理失败：${result.message}` }
      }
      const delivery = result?.delivery ?? { ok: false }
      return {
        ok: true,
        ...(delivery.ok ? { sessionId: delivery.sessionId } : {}),
        message: delivery.ok
          ? `已生成并投递${head}：学科「${result.subject}」${result.isNewSubject ? '（新建）' : ''}，新会话 ${delivery.sessionId}。输出目录：${config.outputDir}`
          : `已生成${head}：学科「${result.subject}」，但未新建会话（${delivery.skipped ?? '投递未执行'}）。输出目录：${config.outputDir}`,
      }
    },
  }), 'dsh-course-notes: scan tool')

  // 轮询定时器
  ctx.effect(() => {
    const id = setInterval(() => { observeOnce().catch((e) => console.error('[dsh-course-notes] 观察异常：', e)) }, config.pollIntervalMs)
    return () => clearInterval(id)
  }, 'dsh-course-notes: poll timer')

  console.log(`[dsh-course-notes] 已启动：每 ${config.pollIntervalMs}ms 轮询前台窗口，输出目录 ${config.outputDir}`)
}
