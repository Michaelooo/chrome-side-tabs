#!/usr/bin/env node

import { createWriteStream, existsSync, readFileSync } from 'fs'
import { mkdir, readdir } from 'fs/promises'
import { join, resolve } from 'path'
import { ZipArchive } from 'archiver'

const root = resolve(import.meta.dirname, '..')
const distDir = resolve(root, 'dist')
const outDir = resolve(root, 'release')

const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const zipPath = join(outDir, `chrome-side-tabs-v${version}.zip`)

async function createZip() {
  if (!existsSync(distDir)) {
    throw new Error('dist/ 目录不存在，请先运行 pnpm build')
  }
  if ((await readdir(distDir)).length === 0) {
    throw new Error('dist/ 目录为空，请确认构建是否成功')
  }

  await mkdir(outDir, { recursive: true })

  const output = createWriteStream(zipPath)
  const archive = new ZipArchive({ zlib: { level: 9 } })

  const done = new Promise((resolvePromise, rejectPromise) => {
    output.on('close', resolvePromise)
    output.on('error', rejectPromise)
    archive.on('error', rejectPromise)
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        console.warn(err.message)
      } else {
        rejectPromise(err)
      }
    })
  })

  archive.pipe(output)
  // dist/ 内容直接落在 ZIP 根目录，Chrome 才能识别 manifest.json
  archive.directory(distDir, false, (entry) => (
    entry.name.endsWith('.DS_Store') ? false : entry
  ))
  await archive.finalize()
  await done

  console.log(`打包完成: ${zipPath} (${archive.pointer()} bytes)`)
}

createZip().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
