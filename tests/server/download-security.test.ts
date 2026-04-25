import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

type BackendType = 'local' | 'docker' | 'ssh' | 'singularity'

function createTempPaths() {
  const rootDir = mkdtempSync(join(tmpdir(), 'hwui-download-security-'))
  const profileDir = join(rootDir, 'profile')
  const uploadDir = join(rootDir, 'uploads')
  const outsideDir = join(rootDir, 'outside')

  mkdirSync(profileDir, { recursive: true })
  mkdirSync(uploadDir, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })

  return { rootDir, profileDir, uploadDir, outsideDir }
}

function writeBackendConfig(profileDir: string, backend: BackendType) {
  if (backend === 'local') return
  writeFileSync(join(profileDir, 'config.yaml'), `terminal:\n  backend: ${backend}\n`)
}

function createRouteContext(path: string, name?: string) {
  const headers = new Map<string, string>()
  const ctx: any = {
    query: name ? { path, name } : { path },
    body: undefined,
    status: undefined,
    set(key: string, value: string) {
      headers.set(key, value)
    },
  }

  return { ctx, headers }
}

async function loadFileProvider(profileDir: string, uploadDir: string) {
  vi.resetModules()
  process.env.UPLOAD_DIR = uploadDir
  vi.doMock('../../packages/server/src/services/hermes/hermes-profile', () => ({
    getActiveProfileDir: () => profileDir,
    getActiveEnvPath: () => join(profileDir, '.env'),
  }))

  return import('../../packages/server/src/services/hermes/file-provider')
}

async function loadDownloadHandler(profileDir: string, uploadDir: string) {
  vi.resetModules()
  process.env.UPLOAD_DIR = uploadDir
  vi.doMock('../../packages/server/src/services/hermes/hermes-profile', () => ({
    getActiveProfileDir: () => profileDir,
    getActiveEnvPath: () => join(profileDir, '.env'),
  }))

  const { downloadRoutes } = await import('../../packages/server/src/routes/hermes/download')
  const layer = downloadRoutes.stack.find((entry: any) => entry.path === '/api/hermes/download')
  return layer.stack[0]
}

const originalUploadDir = process.env.UPLOAD_DIR
const cleanupRoots: string[] = []

afterEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.unmock('../../packages/server/src/services/hermes/hermes-profile')

  if (originalUploadDir === undefined) {
    delete process.env.UPLOAD_DIR
  } else {
    process.env.UPLOAD_DIR = originalUploadDir
  }

  while (cleanupRoots.length > 0) {
    const rootDir = cleanupRoots.pop()
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true })
    }
  }
})

describe('download security', () => {
  it('允许下载当前 profile 下的相对路径文件', async () => {
    const { rootDir, profileDir, uploadDir } = createTempPaths()
    cleanupRoots.push(rootDir)
    writeFileSync(join(profileDir, 'notes.txt'), 'profile content')

    const handler = await loadDownloadHandler(profileDir, uploadDir)
    const { ctx, headers } = createRouteContext('notes.txt')

    await handler(ctx)

    expect(ctx.status ?? 200).toBe(200)
    expect(Buffer.isBuffer(ctx.body)).toBe(true)
    expect(ctx.body.toString('utf-8')).toBe('profile content')
    expect(headers.get('Content-Type')).toBe('text/plain')
  })

  it('允许下载本地 uploadDir 白名单内的绝对路径文件', async () => {
    const { rootDir, profileDir, uploadDir } = createTempPaths()
    cleanupRoots.push(rootDir)
    const uploadFile = join(uploadDir, 'attachments', 'artifact.txt')
    mkdirSync(join(uploadDir, 'attachments'), { recursive: true })
    writeFileSync(uploadFile, 'upload content')

    const handler = await loadDownloadHandler(profileDir, uploadDir)
    const { ctx } = createRouteContext(uploadFile)

    await handler(ctx)

    expect(ctx.status ?? 200).toBe(200)
    expect(Buffer.isBuffer(ctx.body)).toBe(true)
    expect(ctx.body.toString('utf-8')).toBe('upload content')
  })

  it('拒绝下载非白名单宿主机绝对路径', async () => {
    const { rootDir, profileDir, uploadDir, outsideDir } = createTempPaths()
    cleanupRoots.push(rootDir)
    const outsideFile = join(outsideDir, 'secret.txt')
    writeFileSync(outsideFile, 'secret content')

    const handler = await loadDownloadHandler(profileDir, uploadDir)
    const { ctx } = createRouteContext(outsideFile)

    await handler(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toMatchObject({ code: 'permission_denied' })
  })

  it.each(['docker', 'ssh', 'singularity'] as const)('在 %s backend 下拒绝绝对路径下载', async (backend) => {
    const { rootDir, profileDir, uploadDir, outsideDir } = createTempPaths()
    cleanupRoots.push(rootDir)
    writeBackendConfig(profileDir, backend)
    const outsideFile = join(outsideDir, 'remote-secret.txt')
    writeFileSync(outsideFile, 'remote secret')

    const { resolveDownloadTarget } = await loadFileProvider(profileDir, uploadDir)

    await expect(resolveDownloadTarget(outsideFile)).rejects.toMatchObject({ code: 'permission_denied' })
  })
})
