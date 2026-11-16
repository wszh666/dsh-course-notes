// 省钱护栏单测：非已知平台的页面必须被跳过（零 token），
// 已知平台（B 站 / 学习通）照常处理。
import { shouldSkipByPlatform } from '../lib/index.js'

const cases = [
  // [platform, onlyKnownPlatforms, 期望是否跳过]
  ['unknown', true, true],       // 普通网页 → 跳过
  ['bilibili', true, false],     // B 站 → 处理
  ['xuexitong', true, false],    // 学习通 → 处理
  ['unknown', false, false],     // 关掉护栏 → 交模型判定
]

let failed = 0
for (const [platform, guard, expected] of cases) {
  const got = shouldSkipByPlatform(platform, guard)
  const ok = got === expected
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  platform=${platform} guard=${guard} → skip=${got}（期望 ${expected}）`)
}
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
