// 非知识类判定单测：娱乐 / 游戏 / 其它一律不录入，只有 course 才收。
import { isNonKnowledge } from '../lib/index.js'

const cases = [
  // 娱乐 → 忽略
  [{ isCourse: false, category: 'entertainment' }, true],
  // 游戏 → 忽略
  [{ isCourse: false, category: 'gaming' }, true],
  // 模型自相矛盾：category=game 却填了 isCourse:true → 仍按忽略处理
  [{ isCourse: true, category: 'gaming' }, true],
  [{ isCourse: true, category: 'entertainment' }, true],
  // 其它非知识 → 忽略
  [{ isCourse: false, category: 'other' }, true],
  // 老格式（无 category）但 isCourse:false → 忽略
  [{ isCourse: false }, true],
  // 知识课程 → 录入
  [{ isCourse: true, category: 'course', subject: '机器学习' }, false],
  // 老格式 true → 录入
  [{ isCourse: true }, false],
  // 空/异常 → 不算命中（由调用方按分类失败处理）
  [null, false],
  [undefined, false],
]

let failed = 0
for (const [input, expected] of cases) {
  const got = isNonKnowledge(input)
  const ok = got === expected
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(input)} → ${got}（期望 ${expected}）`)
}
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
