// 标题归一化单测：覆盖真实 Edge 多标签标题、各类浏览器后缀、B 站平台后缀。
import { normalizeTitle } from '../lib/index.js'

const cases = [
  ['【全网最全】DeepSeek Harness超详细教程！50分钟吃透DSH，让SuperAgent给你干活！_哔哩哔哩_bilibili 和另外 5 个页面 - 用户配置 1 - Microsoft\u200b Edge',
    '【全网最全】DeepSeek Harness超详细教程！50分钟吃透DSH，让SuperAgent给你干活！'],
  ['课程名_哔哩哔哩_bilibili - Google Chrome', '课程名'],
  ['课程名 - 哔哩哔哩 - Microsoft Edge', '课程名'],
  ['课程名和另外 2 个页面 - 用户配置 3', '课程名'],
  ['哔哩哔哩 (゜-゜)つロ 干杯~-bilibili 和另外 3 个页面 - 用户配置 1 - Microsoft\u200b Edge', '哔哩哔哩 (゜-゜)つロ 干杯~'],
  ['课程 A - YouTube', '课程 A'],
  ['\u200b零宽前缀课程', '零宽前缀课程'],
]

let failed = 0
for (const [input, expected] of cases) {
  const got = normalizeTitle(input)
  const ok = got === expected
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  in=${JSON.stringify(input)}\n      got=${JSON.stringify(got)}\n      exp=${JSON.stringify(expected)}`)
}

// 守卫规则单测：只有「以平台名开头」才算通用页
const isGeneric = (t) => /^(哔哩哔哩|bilibili)/i.test(t)
const guardCases = [
  ['哔哩哔哩 (゜-゜)つロ 干杯~-bilibili', true],
  ['bilibili 搜索：深度学习', true],
  ['【全网最全】DeepSeek Harness教程', false],
]
for (const [input, expected] of guardCases) {
  const got = isGeneric(input)
  const ok = got === expected
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  guard=${JSON.stringify(input)} → ${got}`)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
