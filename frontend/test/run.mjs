// 零额外依赖的测试运行器：用 vite 自带的 esbuild 把测试 bundle 成临时 ESM，再交给 node:test 跑。
// 用法：node test/run.mjs
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const outfile = join(tmpdir(), `shield-tests-${Date.now()}.mjs`)
try {
  await build({
    entryPoints: ['test/shield-domain.test.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    logLevel: 'warning',
  })
  await import(pathToFileURL(outfile).href)
} finally {
  rmSync(outfile, { force: true })
}
