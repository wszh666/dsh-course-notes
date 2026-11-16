// 联网集成测试：验证「标题 → B 站搜索 → 视频信息 → 弹幕/评论」抓取链路。
// 需要外网；失败只说明当前网络/B 站风控状态，不代表代码缺陷——但会明确报出。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const outDir = mkdtempSync(join(tmpdir(), 'course-notes-net-'))
const tools = new Map()
const disposers = []

const classifyReply = JSON.stringify({
  isCourse: true, category: 'course', subject: 'AI工具',
  title: '【全网最全】DeepSeek Harness超详细教程！50分钟吃透DSH，让SuperAgent给你干活！',
  keywords: ['DSH'],
})
const markdownReply = '## DSH 教程\n\n> 简介\n\n### 核心知识点\n- **主题一**\n  - 要点\n\n### 思维导图\n```mermaid\nmindmap\n  root((DSH教程))\n    主题一\n```'

const ctx = {
  get(name) {
    if (name === 'agents') {
      return { async create(o) { return { agent: { session: { id: o.sessionId }, followup() {}, send() {} }, dispose: async () => {} } } }
    }
    if (name === 'attachments') return { async saveFile({ name, data }) { return { attachmentId: 'x'.repeat(64), name, bytes: data.length } } }
    if (name === 'sessionTitle') return { rename() {} }
    if (name === 'agentPresets') return { async resolve() { return { id: 'standard' } }, async mount() {} }
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'stub', model: 'stub' }) }
    return undefined
  },
  llm: {
    listProviders: () => [{ id: 'stub', models: [{ id: 'stub' }] }],
    stream: ({ messages }) => {
      const text = messages?.[0]?.content?.[0]?.text ?? ''
      const reply = text.includes('只返回一个合法 JSON') ? classifyReply : markdownReply
      return (async function* () { yield { type: 'text-delta', text: reply } })()
    },
  },
  tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) },
}

apply(ctx, { outputDir: outDir, pollIntervalMs: 600000, stablePolls: 1, fetchContent: true, deliver: true })

const scan = tools.get('course_map_scan')
const title = '【全网最全】DeepSeek Harness超详细教程！50分钟吃透DSH，让SuperAgent给你干活！'
await scan.execute({ title, platform: 'bilibili' })

const log = readFileSync(join(outDir, '.state', 'poll.log'), 'utf8')
const biliLine = log.split('\n').filter((l) => l.includes('bili content')).pop() ?? ''
console.log('B站抓取日志：', biliLine || '（无 bili content 行）')

const bvid = /bvid=([^\s]+)/.exec(biliLine)?.[1] ?? 'none'
const danmaku = Number(/danmaku=(\d+)/.exec(biliLine)?.[1] ?? 0)
const comments = Number(/comments=(\d+)/.exec(biliLine)?.[1] ?? 0)

let failures = 0
const check = (name, cond, detail = '') => { if (!cond) failures += 1; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`) }
check('反查到 bvid', bvid !== 'none' && /^BV/.test(bvid), bvid)
check('抓到弹幕', danmaku > 0, `${danmaku} 条`)
check('抓到热评', comments > 0, `${comments} 条`)

for (const d of disposers) { try { d() } catch { /* 忽略 */ } }
rmSync(outDir, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
