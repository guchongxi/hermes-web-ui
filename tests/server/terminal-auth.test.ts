import { beforeEach, describe, expect, it, vi } from 'vitest'

const wsState = vi.hoisted(() => ({
  handleUpgrade: vi.fn(),
}))

vi.mock('ws', () => ({
  WebSocketServer: vi.fn().mockImplementation(() => ({
    handleUpgrade: wsState.handleUpgrade,
    on: vi.fn(),
    emit: vi.fn(),
  })),
}))

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 123,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
  })),
}))

function createHttpServer() {
  const handlers = new Map<string, any>()
  return {
    server: {
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler)
      }),
    } as any,
    getUpgradeHandler() {
      return handlers.get('upgrade')
    },
  }
}

function createSocket() {
  return {
    write: vi.fn(),
    destroy: vi.fn(),
  } as any
}

describe('terminal websocket auth and origin checks', () => {
  beforeEach(() => {
    vi.resetModules()
    wsState.handleUpgrade.mockReset()
  })

  it('rejects browser upgrades when Origin is not in the allowlist', async () => {
    const { parseCorsOrigins } = await import('../../packages/server/src/services/network-security')
    const { setupTerminalWebSocket } = await import('../../packages/server/src/routes/hermes/terminal')
    const { server, getUpgradeHandler } = createHttpServer()

    setupTerminalWebSocket(server, {
      authRuntime: { mode: 'enabled', token: 'secret' },
      corsOrigins: parseCorsOrigins('https://allowed.example'),
      trustProxy: false,
    })

    const upgrade = getUpgradeHandler()
    const socket = createSocket()

    await upgrade({
      url: '/api/hermes/terminal?token=secret',
      headers: {
        host: 'localhost:8648',
        origin: 'https://blocked.example',
      },
      socket: { remoteAddress: '127.0.0.1' },
    }, socket, Buffer.alloc(0))

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'))
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect(wsState.handleUpgrade).not.toHaveBeenCalled()
  })

  it('allows missing Origin for non-browser clients and continues auth', async () => {
    const { parseCorsOrigins } = await import('../../packages/server/src/services/network-security')
    const { setupTerminalWebSocket } = await import('../../packages/server/src/routes/hermes/terminal')
    const { server, getUpgradeHandler } = createHttpServer()

    setupTerminalWebSocket(server, {
      authRuntime: { mode: 'enabled', token: 'secret' },
      corsOrigins: parseCorsOrigins('https://allowed.example'),
      trustProxy: false,
    })

    const upgrade = getUpgradeHandler()
    const socket = createSocket()

    await upgrade({
      url: '/api/hermes/terminal?token=secret',
      headers: {
        host: 'localhost:8648',
      },
      socket: { remoteAddress: '127.0.0.1' },
    }, socket, Buffer.alloc(0))

    expect(socket.write).not.toHaveBeenCalled()
    expect(socket.destroy).not.toHaveBeenCalled()
    expect(wsState.handleUpgrade).toHaveBeenCalledOnce()
  })

  it('rejects upgrades with the wrong token in enabled mode', async () => {
    const { parseCorsOrigins } = await import('../../packages/server/src/services/network-security')
    const { setupTerminalWebSocket } = await import('../../packages/server/src/routes/hermes/terminal')
    const { server, getUpgradeHandler } = createHttpServer()

    setupTerminalWebSocket(server, {
      authRuntime: { mode: 'enabled', token: 'secret' },
      corsOrigins: parseCorsOrigins('*'),
      trustProxy: false,
    })

    const upgrade = getUpgradeHandler()
    const socket = createSocket()

    await upgrade({
      url: '/api/hermes/terminal?token=wrong',
      headers: {
        host: 'localhost:8648',
      },
      socket: { remoteAddress: '127.0.0.1' },
    }, socket, Buffer.alloc(0))

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('401 Unauthorized'))
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect(wsState.handleUpgrade).not.toHaveBeenCalled()
  })

  it('allows upgrades without token in insecure-no-auth mode', async () => {
    const { parseCorsOrigins } = await import('../../packages/server/src/services/network-security')
    const { setupTerminalWebSocket } = await import('../../packages/server/src/routes/hermes/terminal')
    const { server, getUpgradeHandler } = createHttpServer()

    setupTerminalWebSocket(server, {
      authRuntime: { mode: 'insecure-no-auth', token: null },
      corsOrigins: parseCorsOrigins('https://allowed.example'),
      trustProxy: false,
    })

    const upgrade = getUpgradeHandler()
    const socket = createSocket()

    await upgrade({
      url: '/api/hermes/terminal',
      headers: {
        host: 'localhost:8648',
        origin: 'https://allowed.example',
      },
      socket: { remoteAddress: '127.0.0.1' },
    }, socket, Buffer.alloc(0))

    expect(socket.write).not.toHaveBeenCalled()
    expect(socket.destroy).not.toHaveBeenCalled()
    expect(wsState.handleUpgrade).toHaveBeenCalledOnce()
  })
})
