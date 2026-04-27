import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authStatus, login } from '../../packages/server/src/controllers/auth'
import { resetLoginRateLimitStore } from '../../packages/server/src/services/login-rate-limit'

const credentialsMocks = vi.hoisted(() => ({
  getCredentials: vi.fn(),
  setCredentials: vi.fn(),
  verifyCredentials: vi.fn(),
  deleteCredentials: vi.fn(),
}))

const authMocks = vi.hoisted(() => ({
  getToken: vi.fn(),
}))

const securityEventMocks = vi.hoisted(() => ({
  logSecurityEvent: vi.fn(),
}))

vi.mock('../../packages/server/src/services/credentials', () => credentialsMocks)
vi.mock('../../packages/server/src/services/auth', () => authMocks)
vi.mock('../../packages/server/src/services/security-events', () => securityEventMocks)

function createMockCtx({
  body = {},
  remoteAddress = '127.0.0.1',
  forwardedFor,
}: {
  body?: Record<string, unknown>
  remoteAddress?: string
  forwardedFor?: string
} = {}) {
  const headers: Record<string, string> = {}
  if (forwardedFor) {
    headers['x-forwarded-for'] = forwardedFor
  }

  return {
    request: {
      body,
      headers,
      socket: { remoteAddress },
      connection: { remoteAddress },
    },
    status: 200,
    body: null as unknown,
    set: vi.fn(),
  }
}

describe('auth controller', () => {
  const originalTrustProxy = process.env.TRUST_PROXY

  beforeEach(() => {
    vi.clearAllMocks()
    resetLoginRateLimitStore()
    vi.useRealTimers()
    delete process.env.TRUST_PROXY
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalTrustProxy === undefined) {
      delete process.env.TRUST_PROXY
      return
    }

    process.env.TRUST_PROXY = originalTrustProxy
  })

  it('returns auth status without exposing the configured username', async () => {
    credentialsMocks.getCredentials.mockResolvedValue({
      username: 'admin',
      password_hash: 'hash',
      salt: 'salt',
      created_at: Date.now(),
    })
    const ctx = createMockCtx()

    await authStatus(ctx as any)

    expect(ctx.body).toEqual({
      hasPasswordLogin: true,
      username: null,
    })
  })

  it('returns 401 for an incorrect password', async () => {
    credentialsMocks.verifyCredentials.mockResolvedValue(false)
    const ctx = createMockCtx({
      body: {
        username: 'admin',
        password: 'wrong-password',
      },
    })

    await login(ctx as any)

    expect(ctx.status).toBe(401)
    expect(ctx.body).toEqual({ error: 'Invalid username or password' })
    expect(authMocks.getToken).not.toHaveBeenCalled()
    expect(securityEventMocks.logSecurityEvent).toHaveBeenCalledWith('auth.login_invalid_credentials', {
      ip: '127.0.0.1',
    })
  })

  it('returns the static token for a successful login', async () => {
    credentialsMocks.verifyCredentials.mockResolvedValue(true)
    authMocks.getToken.mockResolvedValue('test-token')
    const ctx = createMockCtx({
      body: {
        username: 'admin',
        password: 'correct-password',
      },
    })

    await login(ctx as any)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({ token: 'test-token' })
    expect(securityEventMocks.logSecurityEvent).toHaveBeenCalledWith('auth.login_succeeded', {
      ip: '127.0.0.1',
    })
  })

  it('rate limits repeated failed logins from the same IP with a stable 429 payload', async () => {
    credentialsMocks.verifyCredentials.mockResolvedValue(false)

    for (let index = 0; index < 5; index += 1) {
      const ctx = createMockCtx({
        body: {
          username: 'admin',
          password: `wrong-${index}`,
        },
      })

      await login(ctx as any)
      expect(ctx.status).toBe(401)
    }

    const limitedCtx = createMockCtx({
      body: {
        username: 'admin',
        password: 'wrong-final',
      },
    })

    await login(limitedCtx as any)

    expect(limitedCtx.status).toBe(429)
    expect(limitedCtx.body).toEqual({
      code: 'rate_limited',
      error: 'Too many login attempts. Please try again later.',
    })
    expect(limitedCtx.set).toHaveBeenCalledWith('Retry-After', expect.any(String))
    expect(credentialsMocks.verifyCredentials).toHaveBeenCalledTimes(5)
    expect(securityEventMocks.logSecurityEvent).toHaveBeenLastCalledWith('auth.login_rate_limited', {
      ip: '127.0.0.1',
      retryAfterSeconds: expect.any(Number),
    })
  })

  it('ignores x-forwarded-for when TRUST_PROXY is disabled', async () => {
    credentialsMocks.verifyCredentials.mockResolvedValue(false)

    for (let index = 0; index < 5; index += 1) {
      const ctx = createMockCtx({
        body: {
          username: 'admin',
          password: `wrong-${index}`,
        },
        remoteAddress: '10.0.0.2',
        forwardedFor: `203.0.113.${index + 1}`,
      })

      await login(ctx as any)
      expect(ctx.status).toBe(401)
    }

    const limitedCtx = createMockCtx({
      body: {
        username: 'admin',
        password: 'wrong-final',
      },
      remoteAddress: '10.0.0.2',
      forwardedFor: '198.51.100.10',
    })

    await login(limitedCtx as any)

    expect(limitedCtx.status).toBe(429)
  })

  it('uses the first forwarded IP when TRUST_PROXY is enabled', async () => {
    process.env.TRUST_PROXY = '1'
    credentialsMocks.verifyCredentials.mockResolvedValue(false)

    for (let index = 0; index < 5; index += 1) {
      const ctx = createMockCtx({
        body: {
          username: 'admin',
          password: `wrong-${index}`,
        },
        remoteAddress: '10.0.0.2',
        forwardedFor: '203.0.113.7, 203.0.113.8',
      })

      await login(ctx as any)
      expect(ctx.status).toBe(401)
    }

    const differentForwardedIpCtx = createMockCtx({
      body: {
        username: 'admin',
        password: 'wrong-different-forwarded-ip',
      },
      remoteAddress: '10.0.0.2',
      forwardedFor: '198.51.100.10, 203.0.113.8',
    })

    await login(differentForwardedIpCtx as any)

    expect(differentForwardedIpCtx.status).toBe(401)

    const limitedCtx = createMockCtx({
      body: {
        username: 'admin',
        password: 'wrong-same-forwarded-ip',
      },
      remoteAddress: '10.0.0.2',
      forwardedFor: '203.0.113.7, 203.0.113.99',
    })

    await login(limitedCtx as any)

    expect(limitedCtx.status).toBe(429)
  })

  it('clears failed attempts for the IP after a successful login', async () => {
    credentialsMocks.verifyCredentials.mockImplementation(async (_username: string, password: string) => password === 'correct-password')
    authMocks.getToken.mockResolvedValue('test-token')

    for (let index = 0; index < 4; index += 1) {
      const ctx = createMockCtx({
        body: {
          username: 'admin',
          password: `wrong-before-success-${index}`,
        },
      })

      await login(ctx as any)
      expect(ctx.status).toBe(401)
    }

    const successCtx = createMockCtx({
      body: {
        username: 'admin',
        password: 'correct-password',
      },
    })

    await login(successCtx as any)

    expect(successCtx.status).toBe(200)
    expect(successCtx.body).toEqual({ token: 'test-token' })

    for (let index = 0; index < 5; index += 1) {
      const ctx = createMockCtx({
        body: {
          username: 'admin',
          password: `wrong-after-success-${index}`,
        },
      })

      await login(ctx as any)
      expect(ctx.status).toBe(401)
    }

    const limitedCtx = createMockCtx({
      body: {
        username: 'admin',
        password: 'wrong-after-reset-window',
      },
    })

    await login(limitedCtx as any)

    expect(limitedCtx.status).toBe(429)
    expect(credentialsMocks.verifyCredentials).toHaveBeenCalledTimes(10)
  })

  it('unblocks the IP after the rate-limit window expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-26T01:00:00.000Z'))
    credentialsMocks.verifyCredentials.mockResolvedValue(false)

    for (let index = 0; index < 5; index += 1) {
      const ctx = createMockCtx({
        body: {
          username: 'admin',
          password: `wrong-${index}`,
        },
      })

      await login(ctx as any)
      expect(ctx.status).toBe(401)
    }

    const limitedCtx = createMockCtx({
      body: {
        username: 'admin',
        password: 'wrong-limited',
      },
    })

    await login(limitedCtx as any)

    expect(limitedCtx.status).toBe(429)

    vi.setSystemTime(new Date('2026-04-26T01:01:01.000Z'))

    const unblockedCtx = createMockCtx({
      body: {
        username: 'admin',
        password: 'wrong-after-window',
      },
    })

    await login(unblockedCtx as any)

    expect(unblockedCtx.status).toBe(401)
    expect(unblockedCtx.body).toEqual({ error: 'Invalid username or password' })
  })
})
