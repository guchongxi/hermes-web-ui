import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('server startup fail-fast', () => {
  const originalRequireMain = require.main

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  afterEach(() => {
    require.main = originalRequireMain
    vi.restoreAllMocks()
  })

  it('logs fatal and exits with code 1 when auth runtime initialization fails', async () => {
    const fatal = vi.fn()
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    vi.doMock('../../packages/server/src/services/auth', () => ({
      describeAuthRuntime: vi.fn(),
      getAuthRuntime: vi.fn().mockRejectedValue(new Error('AUTH_DISABLED requires ALLOW_INSECURE_NO_AUTH=1|true before startup can continue')),
      requireAuth: vi.fn(),
    }))
    vi.doMock('../../packages/server/src/services/logger', () => ({
      logger: {
        fatal,
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
      },
    }))
    vi.doMock('fs/promises', () => ({
      mkdir: vi.fn().mockResolvedValue(undefined),
    }))

    const { startServer } = await import('../../packages/server/src/index')

    await startServer()

    expect(fatal).toHaveBeenCalledOnce()
    expect(fatal.mock.calls[0][1]).toBe('Failed to bootstrap server')
    expect(exit).toHaveBeenCalledWith(1)
  })
})
