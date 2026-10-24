// Bundles each Lambda handler into dist/<name>/index.js (CommonJS, Node 22).
// SAM then zips each dist/<name> folder as-is (no `sam build` needed).
import { build } from 'esbuild'
import { readdirSync, rmSync } from 'node:fs'

const handlers = readdirSync('src/handlers').filter((f) => f.endsWith('.ts')).map((f) => f.replace(/\.ts$/, ''))
rmSync('dist', { recursive: true, force: true })

await Promise.all(
  handlers.map((name) =>
    build({
      entryPoints: [`src/handlers/${name}.ts`],
      outfile: `dist/${name}/index.js`,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      minify: true,
      logLevel: 'warning',
    }),
  ),
)
console.log(`built ${handlers.length} handlers: ${handlers.join(', ')}`)
