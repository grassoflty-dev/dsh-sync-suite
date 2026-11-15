const fs = require('fs')
const f = 'tools/test/validate.test.mjs'
let s = fs.readFileSync(f, 'utf8')
const before = (s.match(/@crossplatform/g) || []).length
s = s.replace(/^[ \t]*@crossplatform[ \t]*\r?\n/gm, '')
fs.writeFileSync(f, s)
console.log('removed @crossplatform from fixture:', before)
