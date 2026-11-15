const fs = require('fs')
const f = 'oh-package.json5'
let s = fs.readFileSync(f, 'utf8')
if (!s.includes('@ohos/hypium')) {
  s = s.replace(/"devDependencies"\s*:\s*\{[^}]*\}/, '"devDependencies": {\n    "@ohos/hypium": "1.0.25"\n  }')
  fs.writeFileSync(f, s)
  console.log('added hypium')
} else {
  console.log('hypium already present')
}
