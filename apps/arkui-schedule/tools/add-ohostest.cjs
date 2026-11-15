const fs = require('fs')
const files = ['entry/build-profile.harmony.json5', 'entry/build-profile.arkui-x.json5', 'entry/build-profile.json5']
for (const f of files) {
  let s = fs.readFileSync(f, 'utf8')
  if (s.includes('"ohosTest"')) continue
  // 在 targets 数组的最后一个 target 之后追加 ohosTest
  s = s.replace(/(\n\s*\]\n\s*\}\n\s*\]\n\})/, '\n    },\n    { "name": "ohosTest" }\n  ]\n}\n')
  fs.writeFileSync(f, s)
  console.log('patched', f)
}
