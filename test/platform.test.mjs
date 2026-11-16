// 平台识别单测：B 站 / 学习通 / 超星 的标题都能被正确判定，
// 且学习通页面的后缀能被剥离干净。
import { detectPlatform, normalizeTitle } from '../lib/index.js'

const cases = [
  // [原始前台标题, 期望平台]
  ['【全网最全】DSH教程_哔哩哔哩_bilibili 和另外 2 个页面 - 用户配置 1 - Microsoft\u200b Edge', 'bilibili'],
  ['高等数学 第3章 导数 - 学习通', 'xuexitong'],
  ['数据结构与算法 - 超星学习通', 'xuexitong'],
  ['第5讲 概率论基础 - 学堂在线', 'xuexitong'],
  ['大学物理_超星尔雅 - Google Chrome', 'xuexitong'],
  ['某个普通网页 - Google Chrome', 'unknown'],
]

let failed = 0
for (const [raw, expected] of cases) {
  const clean = normalizeTitle(raw)
  const got = detectPlatform(raw, clean)
  const ok = got === expected
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  platform=${got}（期望 ${expected}）  clean=${JSON.stringify(clean)}`)
}

// 学习通后缀必须剥干净
const suffixCases = [
  ['高等数学 第3章 导数 - 学习通', '高等数学 第3章 导数'],
  ['数据结构与算法 - 超星学习通', '数据结构与算法'],
  ['大学物理_超星尔雅', '大学物理'],
]
for (const [raw, expected] of suffixCases) {
  const got = normalizeTitle(raw)
  const ok = got === expected
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  normalize=${JSON.stringify(got)}（期望 ${JSON.stringify(expected)}）`)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
