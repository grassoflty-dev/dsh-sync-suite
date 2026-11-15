const fs = require('fs')
for (const f of ['build-profile.arkui-x.json5', 'build-profile.json5']) {
  let s = fs.readFileSync(f, 'utf8')
  s = s.replace(/[ \t]*"useNormalizedOHMUrl":\s*true,?\r?\n/g, '')
  fs.writeFileSync(f, s)
}
console.log('cleaned useNormalizedOHMUrl')
