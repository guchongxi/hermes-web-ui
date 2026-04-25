import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

type FsMocks = {
  readFile: ReturnType<typeof vi.fn>
  writeFile: ReturnType<typeof vi.fn>
  mkdir: ReturnType<typeof vi.fn>
}

async function loadAuth(overrides: Partial<FsMocks> & { home?: string } = {}) {
  const readFile = overrides.readFile ?? vi.fn()
  const writeFile = overrides.writeFile ?? vi.fn()
  const mkdir = overrides.mkdir ?? vi.fn()
  const home = overrides.home ?? '/tmp/hermes-home'

  vi.resetModules()
  vi.doMock('fs/promises', () => ({ readFile, writeFile, mkdir }))
  vi.doMock('os', () => ({ homedir: () => home }))

  const mod = await import('../../packages/server/src/services/auth')
  return {
    ...mod,
    mocks: { readFile, writeFile, mkdir },
    appHome: `${home}/.hermes-web-ui`,
    tokenFile: `${home}/.hermes-web-ui/.token`,
  }
}

function createMockCtx(path: string, headers: Record<string, string> = {}, query: Record<string, string> = {}) {
  return {
    path,
    headers,
    query,
    status: 200,
    body: null,
    set: vi.fn(),
  }
}

describe('Auth Service', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    vi.clearAllMocks()
  })

  afterAll(() => {
    process.env = originalEnv
  })

  describe('getAuthRuntime', () => {
    it('fails fast when AUTH_DISABLED=1 without explicit insecure override', async () => {
      process.env.AUTH_DISABLED = '1'
      const { getAuthRuntime, mocks } = await loadAuth()

      await expect(getAuthRuntime()).rejects.toThrow(/ALLOW_INSECURE_NO_AUTH/i)

      expect(mocks.readFile).not.toHaveBeenCalled()
    })

    it('enters insecure-no-auth mode only when both flags are enabled', async () => {
      process.env.AUTH_DISABLED = 'true'
      process.env.ALLOW_INSECURE_NO_AUTH = 'true'
      const { getAuthRuntime } = await loadAuth()

      await expect(getAuthRuntime()).resolves.toEqual({
        mode: 'insecure-no-auth',
        token: null,
      })
    })

    it('returns AUTH_TOKEN env var if set', async () => {
      process.env.AUTH_TOKEN = 'my-custom-token'
      const { getAuthRuntime, mocks } = await loadAuth()

      const runtime = await getAuthRuntime()

      expect(runtime).toEqual({
        mode: 'enabled',
        token: 'my-custom-token',
      })
      expect(mocks.readFile).not.toHaveBeenCalled()
    })

    it('reads token from file if it exists', async () => {
      const readFile = vi.fn().mockResolvedValue('file-token\n')
      const { getAuthRuntime, tokenFile } = await loadAuth({ readFile })

      const runtime = await getAuthRuntime()

      expect(runtime).toEqual({
        mode: 'enabled',
        token: 'file-token',
      })
      expect(readFile).toHaveBeenCalledWith(tokenFile, 'utf-8')
    })

    it('generates and saves a token if the token file is missing', async () => {
      const readFile = vi.fn().mockRejectedValue(new Error('ENOENT'))
      const writeFile = vi.fn()
      const mkdir = vi.fn()
      const { getAuthRuntime, appHome, tokenFile } = await loadAuth({ readFile, writeFile, mkdir })

      const runtime = await getAuthRuntime()

      expect(runtime).toEqual({
        mode: 'enabled',
        token: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      expect(mkdir).toHaveBeenCalledWith(appHome, { recursive: true })
      expect(writeFile).toHaveBeenCalledWith(
        tokenFile,
        expect.stringMatching(/^[a-f0-9]{64}\n$/),
        { mode: 0o600 },
      )
    })
  })

  describe('getToken', () => {
    it('returns null in insecure-no-auth mode', async () => {
      process.env.AUTH_DISABLED = '1'
      process.env.ALLOW_INSECURE_NO_AUTH = '1'
      const { getToken } = await loadAuth()

      await expect(getToken()).resolves.toBeNull()
    })
  })

  describe('describeAuthRuntime', () => {
    it('returns a token-free startup summary for enabled auth', async () => {
      const { describeAuthRuntime } = await loadAuth()

      expect(describeAuthRuntime({ mode: 'enabled', token: 'secret-token' })).toBe('Auth enabled')
    })

    it('returns a high-risk warning for insecure-no-auth mode without leaking token fields', async () => {
      const { describeAuthRuntime } = await loadAuth()

      const summary = describeAuthRuntime({ mode: 'insecure-no-auth', token: null })

      expect(summary).toMatch(/WARNING/i)
      expect(summary).not.toMatch(/token|authorization/i)
    })
  })

  describe('requireAuth', () => {
    it('allows all requests in insecure-no-auth mode', async () => {
      const { requireAuth } = await loadAuth()
      const middleware = requireAuth({ mode: 'insecure-no-auth', token: null })
      const ctx = createMockCtx('/api/hermes/sessions')
      const next = vi.fn(async () => {})

      await middleware(ctx, next)

      expect(next).toHaveBeenCalledOnce()
    })

    it('skips /health', async () => {
      const { requireAuth } = await loadAuth()
      const middleware = requireAuth({ mode: 'enabled', token: 'secret' })
      const ctx = createMockCtx('/health')
      const next = vi.fn(async () => {})

      await middleware(ctx, next)

      expect(next).toHaveBeenCalledOnce()
      expect(ctx.status).toBe(200)
    })

    it('skips /webhook because it is treated as a public non-API path', async () => {
      const { requireAuth } = await loadAuth()
      const middleware = requireAuth({ mode: 'enabled', token: 'secret' })
      const ctx = createMockCtx('/webhook')
      const next = vi.fn(async () => {})

      await middleware(ctx, next)

      expect(next).toHaveBeenCalledOnce()
      expect(ctx.status).toBe(200)
    })

    it('skips non-API paths', async () => {
      const { requireAuth } = await loadAuth()
      const middleware = requireAuth({ mode: 'enabled', token: 'secret' })
      const ctx = createMockCtx('/index.html')
      const next = vi.fn(async () => {})

      await middleware(ctx, next)

      expect(next).toHaveBeenCalledOnce()
      expect(ctx.status).toBe(200)
    })

    it('requires auth for /upload', async () => {
      const { requireAuth } = await loadAuth()
      const middleware = requireAuth({ mode: 'enabled', token: 'secret' })
      const ctx = createMockCtx('/upload')
      const next = vi.fn(async () => {})

      await middleware(ctx, next)

      expect(ctx.status).toBe(401)
      expect(ctx.body).toEqual({ error: 'Unauthorized' })
      expect(next).not.toHaveBeenCalled()
    })

    it('rejects request without auth header for protected API routes', async () => {
      const { requireAuth } = await loadAuth()
      const middleware = requireAuth({ mode: 'enabled', token: 'secret' })
      const ctx = createMockCtx('/api/hermes/sessions')
      const next = vi.fn(async () => {})

      await middleware(ctx, next)

      expect(ctx.status).toBe(401)
      expect(next).not.toHaveBeenCalled()
    })

    it('rejects request with the wrong bearer token', async () => {
      const { requireAuth } = await loadAuth()
      const middleware = requireAuth({ mode: 'enabled', token: 'secret' })
      const ctx = createMockCtx('/api/hermes/sessions', { authorization: 'Bearer wrong' })
      const next = vi.fn(async () => {})

      await middleware(ctx, next)

      expect(ctx.status).toBe(401)
      expect(next).not.toHaveBeenCalled()
    })

    it('allows request with the correct bearer token', async () => {
      const { requireAuth } = await loadAuth()
      const middleware = requireAuth({ mode: 'enabled', token: 'secret' })
      const ctx = createMockCtx('/api/hermes/sessions', { authorization: 'Bearer secret' })
      const next = vi.fn(async () => {})

      await middleware(ctx, next)

      expect(next).toHaveBeenCalledOnce()
    })

    it('allows request with the correct query token', async () => {
      const { requireAuth } = await loadAuth()
      const middleware = requireAuth({ mode: 'enabled', token: 'secret' })
      const ctx = createMockCtx('/api/hermes/sessions', {}, { token: 'secret' })
      const next = vi.fn(async () => {})

      await middleware(ctx, next)

      expect(next).toHaveBeenCalledOnce()
    })

    it('returns 401 JSON on auth failure', async () => {
      const { requireAuth } = await loadAuth()
      const middleware = requireAuth({ mode: 'enabled', token: 'secret' })
      const ctx = createMockCtx('/api/hermes/sessions', { authorization: 'Bearer wrong' })
      const next = vi.fn(async () => {})

      await middleware(ctx, next)

      expect(ctx.status).toBe(401)
      expect(ctx.set).toHaveBeenCalledWith('Content-Type', 'application/json')
      expect(ctx.body).toEqual({ error: 'Unauthorized' })
    })
  })

  describe('network security helpers', () => {
    it('allows missing origin for non-browser clients', async () => {
      vi.resetModules()
      const { parseCorsOrigins, isOriginAllowed } = await import('../../packages/server/src/services/network-security')

      const policy = parseCorsOrigins('https://allowed.example')

      expect(isOriginAllowed(policy, undefined)).toBe(true)
      expect(isOriginAllowed(policy, null)).toBe(true)
    })

    it('rejects origins outside the configured allowlist', async () => {
      vi.resetModules()
      const { parseCorsOrigins, isOriginAllowed } = await import('../../packages/server/src/services/network-security')

      const policy = parseCorsOrigins('https://allowed.example, https://console.example')

      expect(isOriginAllowed(policy, 'https://allowed.example')).toBe(true)
      expect(isOriginAllowed(policy, 'https://blocked.example')).toBe(false)
    })

    it('prefers remoteAddress unless trust proxy is explicitly enabled', async () => {
      vi.resetModules()
      const { extractClientIp } = await import('../../packages/server/src/services/network-security')

      const ip = extractClientIp({
        socket: { remoteAddress: '10.0.0.2' },
        headers: { 'x-forwarded-for': '203.0.113.7, 203.0.113.8' },
      })

      expect(ip).toBe('10.0.0.2')
    })

    it('uses the first forwarded IP only when trust proxy is enabled', async () => {
      vi.resetModules()
      const { extractClientIp } = await import('../../packages/server/src/services/network-security')

      const ip = extractClientIp({
        socket: { remoteAddress: '10.0.0.2' },
        headers: { 'x-forwarded-for': '203.0.113.7, 203.0.113.8' },
      }, { trustProxy: true })

      expect(ip).toBe('203.0.113.7')
    })
  })
})
