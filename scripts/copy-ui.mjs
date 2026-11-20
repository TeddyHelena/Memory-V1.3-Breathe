import fs from 'node:fs'
import path from 'node:path'
const src = path.join(import.meta.dirname, '..', 'src', 'client', 'ui', '01-Memory.html')
const dst = path.join(import.meta.dirname, '..', 'lib', 'memory-ui.html')
fs.mkdirSync(path.dirname(dst), { recursive: true })
fs.copyFileSync(src, dst)
console.log('copied memory-ui.html')
