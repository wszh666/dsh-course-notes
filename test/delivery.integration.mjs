// 离线集成测试：不依赖 DSH 运行时，用假 ctx 跑通
//   apply → course_map_scan → 分类 → 生成 → Word → 建会话 → 投递附件 → 改名
// 目的：在重启 DSH 之前就把投递链路的 API 用法（ctx.get / agents.create /
// attachments.saveFile / sessionTitle.rename）验出来。
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const outDir = mkdtempSync(join(tmpdir(), 'course-notes-it-'))
const calls = { created: [], followups: [], savedFiles: [], renames: [], mounted: [], appended: [] }
let failures = 0

function check(name, cond, detail = '') {
  if (!cond) failures += 1
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

// ---- 假 LLM：根据提示词内容返回分类 JSON 或 Markdown ----
const classifyReply = JSON.stringify({
  isCourse: true, category: 'course', subject: 'AI工具',
  title: 'DSH 教程', keywords: ['DSH', 'Agent', '工具'],
})
const markdownReply = [
  '## DSH 教程', '', '> 一句话简介', '',
  '### 核心知识点', '- **主题一**', '  - 要点A', '  - 要点B', '',
  '### 学习建议', '- 建议一', '',
  '### 思维导图', '```mermaid', 'mindmap', '  root((DSH教程))', '    主题一', '```',
].join('\n')

const llm = {
  listProviders: () => [{ id: 'stub-provider', models: [{ id: 'stub-model' }] }],
  stream: ({ messages }) => {
    const text = messages?.[0]?.content?.[0]?.text ?? ''
    let reply = markdownReply
    if (text.includes('只返回一个合法 JSON')) {
      // 游戏视频走非知识分支，其余走课程分支
      reply = text.includes('原神')
        ? JSON.stringify({ isCourse: false, category: 'gaming', subject: '', title: '原神实况', keywords: [] })
        : classifyReply
    }
    return (async function* () {
      yield { type: 'text-delta', text: reply }
      yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 } }
    })()
  },
}

const tools = new Map()
const disposers = []

const ctx = {
  // cordis 服务一律走 get()；这里也顺便验证代码没有直接读属性
  get(name) {
    if (name === 'agents') {
      return {
        async create(options) {
          calls.created.push(options)
          // 真实 DSH 在 create 内、发布前执行 setup 回调以挂载 Agent 预设
          if (typeof options.setup === 'function') await options.setup({})
          return {
            agent: {
              session: {
                id: options.sessionId,
                append(type, data, opts) { calls.appended.push({ type, data, opts }) },
              },
              followup: (message) => calls.followups.push(message),
              send: (message) => calls.followups.push(message),
            },
            dispose: async () => {},
          }
        },
      }
    }
    if (name === 'attachments') {
      return {
        async saveFile({ name, data }) {
          calls.savedFiles.push({ name, bytes: data.length })
          return { attachmentId: 'a'.repeat(64), name, bytes: data.length }
        },
      }
    }
    if (name === 'sessionTitle') {
      return { rename: (session, title) => calls.renames.push({ session: session.id, title }) }
    }
    if (name === 'agentPresets') {
      return {
        async resolve() { return { id: 'standard' } },
        async mount(_ctx, id) { calls.mounted.push(id) },
      }
    }
    if (name === 'agentDefaultModel') {
      return { currentSelection: () => ({ provider: 'stub-provider', model: 'stub-model' }) }
    }
    return undefined
  },
  llm,
  tools: {
    register(def) {
      tools.set(def.name, def)
      return () => tools.delete(def.name)
    },
  },
  effect(fn, _label) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
}

apply(ctx, {
  outputDir: outDir,
  pollIntervalMs: 600000,
  stablePolls: 1,
  fetchContent: false, // 跳过 B 站网络请求
  deliver: true,
  deliverWakeup: true,
})

check('注册了 course_map_status', tools.has('course_map_status'))
check('注册了 course_map_scan', tools.has('course_map_scan'))

const scan = tools.get('course_map_scan')
const result = await scan.execute({ title: 'DSH 教程 - Google Chrome', platform: 'bilibili' })

check('scan 返回 ok', result.ok === true, result.message)
check('新建了 1 个会话', calls.created.length === 1, `实际 ${calls.created.length}`)
check('会话 cwd 指向工作区', Boolean(calls.created[0]?.meta?.cwd), String(calls.created[0]?.meta?.cwd))
check('挂载了 agentPresets', calls.mounted.includes('standard'))
check('docx 附件已保存', calls.savedFiles.length === 1 && calls.savedFiles[0].name.endsWith('.docx'), JSON.stringify(calls.savedFiles))
check('投递消息已发出', calls.followups.length === 1)
const delivered = calls.followups[0]
check('投递消息含 file 块', Array.isArray(delivered?.content) && delivered.content[0]?.type === 'file',
  JSON.stringify(delivered?.content?.[0]?.type))
check('投递消息含文字指令', delivered?.content?.some((c) => c.type === 'text' && c.text.includes('present')))
check('会话已改名', calls.renames.length === 1 && calls.renames[0].title.includes('课程笔记'), JSON.stringify(calls.renames))

// 产出文件检查
const subjectDir = join(outDir, 'AI工具')
check('生成了学科目录', existsSync(subjectDir))
const docxFiles = existsSync(subjectDir) ? readFileSync(join(subjectDir, '学习手册.docx')).length : 0
check('学习手册.docx 非空', docxFiles > 1000, `${docxFiles} bytes`)
check('生成了课程总览.docx', existsSync(join(outDir, '课程总览.docx')))

const state = JSON.parse(readFileSync(join(outDir, '.state', 'state.json'), 'utf8'))
check('state 记录了投递会话', Boolean(state.lastDeliveredSession), state.lastDeliveredSession)
check('state 记录学科', Object.keys(state.subjects).includes('AI工具'))
check('state 累计了 token 用量', (state.usage?.videos ?? 0) >= 1 && state.usage?.generate?.inputTokens > 0,
  JSON.stringify(state.usage))

// 幂等：同一标题再次扫描应静默跳过
const again = await scan.execute({ title: 'DSH 教程 - Google Chrome', platform: 'bilibili' })
check('重复标题静默跳过', again.skipped === 'seen', again.message)
check('重复扫描不再建会话', calls.created.length === 1, `实际 ${calls.created.length}`)

// 娱乐/游戏：静默忽略，不建会话、不产出文件
const beforeSessions = calls.created.length
const game = await scan.execute({ title: '【原神】3.2版本深渊满星速通实况解说_哔哩哔哩_bilibili', platform: 'bilibili' })
check('游戏视频被静默忽略', game.ok === true && game.skipped === 'gaming', `${game.skipped} / ${game.message}`)
check('游戏视频不建会话', calls.created.length === beforeSessions, `实际 ${calls.created.length}`)
check('游戏视频不进学科台账', Object.keys(JSON.parse(readFileSync(join(outDir, '.state', 'state.json'), 'utf8')).subjects).join(',') === 'AI工具')

// ---- append 模式：零 token 投递（直接写会话表面，不触发回合）----
const outDir2 = mkdtempSync(join(tmpdir(), 'course-notes-append-'))
const calls2 = { created: [], followups: [], savedFiles: [], appended: [] }
const tools2 = new Map()
const disposers2 = []
const ctx2 = {
  get(name) {
    if (name === 'agents') {
      return {
        async create(options) {
          calls2.created.push(options)
          return {
            agent: {
              session: {
                id: options.sessionId,
                append(type, data, opts) { calls2.appended.push({ type, data, opts }) },
              },
              followup: (message) => calls2.followups.push(message),
            },
            dispose: async () => {},
          }
        },
      }
    }
    if (name === 'attachments') return { async saveFile({ name, data }) { calls2.savedFiles.push({ name, bytes: data.length }); return { attachmentId: 'b'.repeat(64), name, bytes: data.length } } }
    if (name === 'sessionTitle') return { rename() {} }
    if (name === 'agentPresets') return { async resolve() { return { id: 'standard' } }, async mount() {} }
    return undefined
  },
  llm,
  tools: { register(def) { tools2.set(def.name, def); return () => tools2.delete(def.name) } },
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers2.push(d) },
}

apply(ctx2, {
  outputDir: outDir2, pollIntervalMs: 600000, stablePolls: 1,
  fetchContent: false, deliver: true, deliverMode: 'append',
})
await tools2.get('course_map_scan').execute({ title: '线性代数 矩阵 - Google Chrome', platform: 'bilibili' })

check('append 模式不触发回合', calls2.followups.length === 0, `followup ${calls2.followups.length}`)
check('append 模式写入了会话表面', calls2.appended.length === 1 && calls2.appended[0].type === 'user/message', JSON.stringify(calls2.appended.map((a) => a.type)))
check('append 消息带 append surfaceOp', calls2.appended[0]?.opts?.surfaceOp === 'append', JSON.stringify(calls2.appended[0]?.opts))
check('append 消息含 file 块', calls2.appended[0]?.data?.content?.[0]?.type === 'file')
check('append 消息不含模型指令', !calls2.appended[0]?.data?.content?.some((c) => c.type === 'text' && c.text.includes('调用 present')))
check('append 仍保存了 docx 附件', calls2.savedFiles.length === 1, JSON.stringify(calls2.savedFiles))

for (const dispose of [...disposers, ...disposers2]) { try { dispose() } catch { /* 忽略 */ } }
rmSync(outDir, { recursive: true, force: true })
rmSync(outDir2, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
