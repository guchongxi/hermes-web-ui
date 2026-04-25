import { beforeEach, describe, expect, it, vi } from 'vitest'

function createMultipartBody(boundary: string, filename: string, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`),
    Buffer.from('Content-Type: application/octet-stream\r\n\r\n'),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
}

function createMockRequest(chunks: Buffer[]) {
  const destroy = vi.fn()
  let destroyed = false

  return {
    destroy,
    get destroyed() {
      return destroyed
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk
      }
      destroyed = true
    },
  }
}

async function loadUploadHandler(mocks?: {
  provider?: { writeFile: ReturnType<typeof vi.fn> }
  maxEditSize?: number
}) {
  vi.resetModules()

  const provider = mocks?.provider ?? { writeFile: vi.fn() }
  const createFileProvider = vi.fn().mockResolvedValue(provider)

  vi.doMock('../../packages/server/src/services/hermes/file-provider', () => ({
    createFileProvider,
    resolveHermesPath: vi.fn((input: string) => `/resolved/${input}`),
    isSensitivePath: vi.fn(() => false),
    MAX_EDIT_SIZE: mocks?.maxEditSize ?? 50 * 1024 * 1024,
  }))

  const { fileRoutes } = await import('../../packages/server/src/routes/hermes/files')
  const layer = fileRoutes.stack.find((entry: any) => entry.path === '/api/hermes/files/upload')
  if (!layer) {
    throw new Error('upload route not found')
  }

  return {
    handler: layer.stack[0],
    provider,
    createFileProvider,
  }
}

describe('files upload request limits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('请求体超过 10 MiB 时返回 413，且不会写入 provider', async () => {
    const boundary = '----codex-upload-boundary'
    const oversizedContent = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61)
    const rawBody = createMultipartBody(boundary, 'huge.bin', oversizedContent)
    const { handler, provider, createFileProvider } = await loadUploadHandler()
    const req = createMockRequest([rawBody])

    const ctx: any = {
      query: { path: 'uploads' },
      req,
      status: undefined,
      body: undefined,
      get(name: string) {
        return name === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''
      },
    }

    await handler(ctx)

    expect(ctx.status).toBe(413)
    expect(ctx.body).toMatchObject({ code: 'file_too_large' })
    expect(req.destroy).toHaveBeenCalledTimes(1)
    expect(createFileProvider).not.toHaveBeenCalled()
    expect(provider.writeFile).not.toHaveBeenCalled()
  })
})
