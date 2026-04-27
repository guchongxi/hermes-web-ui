import http from 'http'
import Koa from 'koa'
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

async function createTestServer() {
  const { fileRoutes } = await import('../../packages/server/src/routes/hermes/files')
  const app = new Koa()
  app.use(fileRoutes.routes())
  app.use(fileRoutes.allowedMethods())

  const server = http.createServer(app.callback())
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })

  return server
}

async function closeServer(server: http.Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

async function sendMultipartRequest(server: http.Server, path: string, boundary: string, body: Buffer) {
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('server address unavailable')
  }

  return await new Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf-8'),
          headers: res.headers,
        })
      })
    })

    req.on('error', reject)
    req.write(body)
    req.end()
  })
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
    expect(handler).toBeTypeOf('function')
    const server = await createTestServer()

    const response = await sendMultipartRequest(server, '/api/hermes/files/upload?path=uploads', boundary, rawBody)
    await closeServer(server)

    expect(response.statusCode).toBe(413)
    expect(JSON.parse(response.body)).toMatchObject({ code: 'file_too_large' })
    expect(response.headers.connection).toBe('close')
    expect(createFileProvider).not.toHaveBeenCalled()
    expect(provider.writeFile).not.toHaveBeenCalled()
  })
})
