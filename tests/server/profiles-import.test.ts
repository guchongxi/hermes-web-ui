import { Readable } from 'stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

function createMultipartBody(boundary: string, filename: string, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`),
    Buffer.from('Content-Type: application/gzip\r\n\r\n'),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
}

async function loadImportProfile(overrides?: {
  importProfileImpl?: ReturnType<typeof vi.fn>
}) {
  vi.resetModules()

  const mkdir = vi.fn().mockResolvedValue(undefined)
  const writeFile = vi.fn().mockResolvedValue(undefined)
  const unlink = vi.fn().mockResolvedValue(undefined)
  const importProfile = overrides?.importProfileImpl ?? vi.fn().mockResolvedValue('imported')

  vi.doMock('fs/promises', () => ({
    mkdir,
    writeFile,
    unlink,
  }))
  vi.doMock('crypto', () => ({
    randomUUID: vi.fn(() => 'random-id-123'),
  }))
  vi.doMock('../../packages/server/src/services/hermes/hermes-cli', () => ({
    importProfile,
    listProfiles: vi.fn(),
    getProfile: vi.fn(),
    createProfile: vi.fn(),
    deleteProfile: vi.fn(),
    renameProfile: vi.fn(),
    useProfile: vi.fn(),
    exportProfile: vi.fn(),
    setupReset: vi.fn(),
  }))
  vi.doMock('../../packages/server/src/services/hermes/group-chat', () => ({
    drainPendingSessionDeletes: vi.fn(),
  }))
  vi.doMock('../../packages/server/src/services/gateway-bootstrap', () => ({
    getGatewayManagerInstance: vi.fn(() => null),
  }))
  vi.doMock('../../packages/server/src/services/logger', () => ({
    logger: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  }))

  const profiles = await import('../../packages/server/src/controllers/hermes/profiles')
  return {
    importProfileHandler: profiles.importProfile,
    mkdir,
    writeFile,
    unlink,
    hermesImportProfile: importProfile,
  }
}

describe('profiles import temp file handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('使用服务端随机临时文件名并保留支持的归档后缀', async () => {
    const boundary = '----codex-profile-boundary'
    const rawBody = createMultipartBody(boundary, 'client-name.archive.tar.gz', Buffer.from('archive-data'))
    const { importProfileHandler, writeFile, hermesImportProfile, unlink } = await loadImportProfile()

    const ctx: any = {
      req: Readable.from([rawBody]),
      status: undefined,
      body: undefined,
      get(name: string) {
        return name === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''
      },
    }

    await importProfileHandler(ctx)

    const archivePath = writeFile.mock.calls[0]?.[0]
    expect(typeof archivePath).toBe('string')
    expect(archivePath).toContain('random-id-123.tar.gz')
    expect(archivePath).not.toContain('client-name.archive.tar.gz')
    expect(hermesImportProfile).toHaveBeenCalledWith(archivePath)
    expect(unlink).toHaveBeenCalledWith(archivePath)
    expect(ctx.body).toMatchObject({ success: true })
  })

  it('导入失败后也会清理临时文件', async () => {
    const boundary = '----codex-profile-boundary'
    const rawBody = createMultipartBody(boundary, 'broken.zip', Buffer.from('archive-data'))
    const { importProfileHandler, writeFile, unlink } = await loadImportProfile({
      importProfileImpl: vi.fn().mockRejectedValue(new Error('import failed')),
    })

    const ctx: any = {
      req: Readable.from([rawBody]),
      status: undefined,
      body: undefined,
      get(name: string) {
        return name === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''
      },
    }

    await importProfileHandler(ctx)

    const archivePath = writeFile.mock.calls[0]?.[0]
    expect(ctx.status).toBe(500)
    expect(ctx.body).toMatchObject({ error: 'import failed' })
    expect(unlink).toHaveBeenCalledWith(archivePath)
  })
})
