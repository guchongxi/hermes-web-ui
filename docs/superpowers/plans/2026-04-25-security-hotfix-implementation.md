# Security Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `2026-04-25-security-hotfix-design` 设计完成服务端安全热修，封住已确认的 P0 风险并落地已选定的 P1 止血项，同时同步前端提示与部署文档。

**Architecture:** 先把认证模式、跨协议 origin 校验、可信代理取 IP、以及安全审计日志统一收口到共享服务层，再让 Koa HTTP、terminal WebSocket、group-chat Socket.IO 复用同一套判断。随后按入口分别收紧文件下载、multipart 上传/导入、登录面限流，最后同步 README、Docker 文档和登录页文案，保证行为变化可被运维和终端用户正确理解。

**Tech Stack:** TypeScript, Koa, ws, Socket.IO, Vue 3, vue-i18n, Vitest

---

## Codebase Map

- Create: `packages/server/src/services/network-security.ts`
  - 统一解析 `CORS_ORIGINS`、判定浏览器 `Origin` 是否允许、按 `remoteAddress` / `X-Forwarded-For` 提取客户端 IP。
- Create: `packages/server/src/services/security-events.ts`
  - 统一输出不含 token / Authorization / query token 的安全审计日志。
- Create: `packages/server/src/services/login-rate-limit.ts`
  - 单进程内存限流桶，仅服务 `/api/auth/login`。
- Create: `packages/server/src/services/request-body.ts`
  - 统一做请求体大小累计、超限 early abort、稳定错误码包装。
- Create: `tests/server/terminal-auth.test.ts`
  - 覆盖 terminal WebSocket 的 token/origin 边界。
- Create: `tests/server/download-security.test.ts`
  - 覆盖下载路径白名单与 backend 差异。
- Create: `tests/server/files-upload.test.ts`
  - 覆盖 `files/upload` 的 10 MiB 上限与“未进入写入路径”断言。
- Create: `tests/server/profiles-import.test.ts`
  - 覆盖 `profiles/import` 的 100 MiB 上限、随机临时文件名、清理逻辑。
- Create: `tests/server/auth-controller.test.ts`
  - 覆盖 `auth/status`、`auth/login` 的枚举收口和限流行为。
- Create: `tests/client/account-settings.test.ts`
  - 覆盖 `auth/status.username = null` 后设置页仍正常展示。
- Modify: `packages/server/src/services/auth.ts`
  - 统一认证运行时、禁用模式校验、token 脱敏启动摘要、Koa 认证中间件。
- Modify: `packages/server/src/config.ts`
  - 解析 `ALLOW_INSECURE_NO_AUTH`、`TRUST_PROXY`、上传/导入大小上限、origin allowlist 原始值。
- Modify: `packages/server/src/index.ts`
  - 启动前置校验、统一 CORS、取消完整 token 日志、把共享 runtime 传给 HTTP/WS/Socket.IO。
- Modify: `packages/server/src/routes/hermes/terminal.ts`
  - 复用共享认证模式与 origin allowlist。
- Modify: `packages/server/src/services/hermes/group-chat/index.ts`
  - 复用共享认证模式与 origin allowlist，移除 `origin: '*'`。
- Modify: `packages/server/src/services/hermes/file-provider.ts`
  - 新增下载路径授权判断，明确 local / docker / ssh / singularity 边界。
- Modify: `packages/server/src/routes/hermes/download.ts`
  - 只允许 profile 相对路径与 local uploadDir 白名单绝对路径，拒绝其它绝对路径并打安全日志。
- Modify: `packages/server/src/routes/hermes/files.ts`
  - 为 `files/upload` 接入 10 MiB 总请求体上限与稳定 `413` 错误码。
- Modify: `packages/server/src/controllers/hermes/profiles.ts`
  - 为 `profiles/import` 接入 100 MiB 总请求体上限、服务端随机临时文件名、显式清理。
- Modify: `packages/server/src/controllers/auth.ts`
  - `auth/status` 不再暴露真实用户名，`auth/login` 增加 IP 限流和安全审计日志。
- Modify: `packages/client/src/components/hermes/settings/AccountSettings.vue`
  - 不再依赖 `status.username` 展示文案。
- Modify: `packages/client/src/i18n/locales/en.ts`
  - 移除“去启动日志拿 token”的提示。
- Modify: `packages/client/src/i18n/locales/zh.ts`
  - 移除“去启动日志拿 token”的提示。
- Modify: `packages/client/src/i18n/locales/de.ts`
- Modify: `packages/client/src/i18n/locales/es.ts`
- Modify: `packages/client/src/i18n/locales/fr.ts`
- Modify: `packages/client/src/i18n/locales/ja.ts`
- Modify: `packages/client/src/i18n/locales/ko.ts`
- Modify: `packages/client/src/i18n/locales/pt.ts`
  - 把 `passwordLoginConfigured` 改成不依赖用户名占位符。
- Modify: `README.md`
- Modify: `README_zh.md`
- Modify: `docs/docker.md`
  - 同步新的 token 获取路径、`AUTH_DISABLED=1` 新语义、容器/挂载场景说明。
- Modify: `tests/server/auth.test.ts`
  - 扩充共享认证运行时、脱敏日志、可信代理、origin allowlist 测试。
- Modify: `tests/server/group-chat.test.ts`
  - 扩充 group-chat 握手认证/origin 测试。
- Modify: `tests/client/i18n-coverage.test.ts`
  - 增加“文案不再引导去日志拿 token”的回归断言。

> 提交时只 `git add` 本任务列出的文件，不要把当前工作区其他未提交改动一并带入。

### Task 1: 统一认证模式、跨协议 origin 校验与安全日志基座

**Files:**
- Create: `packages/server/src/services/network-security.ts`
- Create: `packages/server/src/services/security-events.ts`
- Modify: `packages/server/src/services/auth.ts`
- Modify: `packages/server/src/config.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/routes/hermes/terminal.ts`
- Modify: `packages/server/src/services/hermes/group-chat/index.ts`
- Modify: `tests/server/auth.test.ts`
- Modify: `tests/server/group-chat.test.ts`
- Test: `tests/server/terminal-auth.test.ts`

- [ ] **Step 1: 先补共享认证/网络边界的失败测试**

```ts
it('rejects AUTH_DISABLED=1 without ALLOW_INSECURE_NO_AUTH=1', async () => {
  process.env.AUTH_DISABLED = '1'
  delete process.env.ALLOW_INSECURE_NO_AUTH

  const { getAuthRuntime } = await loadAuth()

  await expect(getAuthRuntime()).rejects.toThrow(/ALLOW_INSECURE_NO_AUTH/)
})

it('allows explicit insecure no-auth mode only after double confirmation', async () => {
  process.env.AUTH_DISABLED = '1'
  process.env.ALLOW_INSECURE_NO_AUTH = '1'

  const { getAuthRuntime } = await loadAuth()

  await expect(getAuthRuntime()).resolves.toEqual({
    mode: 'insecure-no-auth',
    token: null,
  })
})

it('never includes the full token in startup log summaries', async () => {
  process.env.AUTH_TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

  const { getAuthRuntime, buildAuthStartupSummary } = await loadAuth()
  const runtime = await getAuthRuntime()
  const summary = buildAuthStartupSummary(runtime)

  expect(JSON.stringify(summary)).not.toContain(process.env.AUTH_TOKEN)
  expect(summary.consoleLine).toBe('Auth enabled')
})
```

- [ ] **Step 2: 给 terminal / group-chat 补握手级失败测试**

```ts
it('rejects terminal websocket when browser Origin is outside the allowlist', async () => {
  const socket = { write: vi.fn(), destroy: vi.fn() }
  const server = createMockHttpServer()
  const runtime = { mode: 'enabled', token: 'secret' } as const
  const policy = { allowAnyOrigin: false, allowedOrigins: new Set(['https://ui.example.com']) }

  setupTerminalWebSocket(server as any, runtime, policy)

  await server.emitUpgrade({
    url: '/api/hermes/terminal?token=secret',
    headers: { host: '127.0.0.1:8648', origin: 'https://evil.example.com' },
  }, socket)

  expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'))
  expect(socket.destroy).toHaveBeenCalled()
})

it('registers a namespace middleware that rejects group-chat handshakes with a bad origin', async () => {
  const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
  const runtime = { mode: 'enabled', token: 'secret' } as const
  const policy = { allowAnyOrigin: false, allowedOrigins: new Set(['https://ui.example.com']) }
  const server = new GroupChatServer({ on: vi.fn() } as any, runtime, policy)

  const middleware = getNamespaceMiddleware(server)
  const next = vi.fn()

  await middleware({
    handshake: {
      auth: { token: 'secret' },
      query: {},
      headers: { origin: 'https://evil.example.com' },
    },
  }, next)

  expect(next).toHaveBeenCalledWith(expect.any(Error))
})
```

- [ ] **Step 3: 运行定向测试，确认当前实现确实不满足设计**

Run: `npx vitest run tests/server/auth.test.ts tests/server/terminal-auth.test.ts tests/server/group-chat.test.ts`

Expected: FAIL，至少包含以下一种失败：
- `AUTH_DISABLED=1` 没有抛错而是直接放行
- 启动摘要仍含完整 token
- terminal / group-chat 未拦截非法 `Origin`

- [ ] **Step 4: 实现共享认证运行时、origin 判定和安全日志 helper**

```ts
export type AuthRuntime =
  | { mode: 'enabled'; token: string }
  | { mode: 'insecure-no-auth'; token: null }

export async function getAuthRuntime(): Promise<AuthRuntime> {
  const authDisabled = ['1', 'true'].includes(String(process.env.AUTH_DISABLED).toLowerCase())
  const allowInsecure = ['1', 'true'].includes(String(process.env.ALLOW_INSECURE_NO_AUTH).toLowerCase())

  if (!authDisabled) {
    return { mode: 'enabled', token: await getTokenFromEnvOrFile() }
  }

  if (!allowInsecure) {
    throw new Error('AUTH_DISABLED=1 requires ALLOW_INSECURE_NO_AUTH=1')
  }

  return { mode: 'insecure-no-auth', token: null }
}

export function buildAuthStartupSummary(runtime: AuthRuntime) {
  if (runtime.mode === 'enabled') {
    return {
      consoleLine: 'Auth enabled',
      message: 'Auth enabled',
      logFields: { authMode: runtime.mode },
    }
  }

  return {
    consoleLine: 'Auth disabled (explicit insecure override active)',
    message: 'Auth disabled (explicit insecure override active)',
    logFields: { authMode: runtime.mode, warning: 'insecure_no_auth' },
  }
}

export function parseOriginPolicy(raw: string) {
  const values = raw.split(',').map((item) => item.trim()).filter(Boolean)
  if (values.length === 1 && values[0] === '*') {
    return { allowAnyOrigin: true, allowedOrigins: new Set<string>() }
  }
  return { allowAnyOrigin: false, allowedOrigins: new Set(values) }
}

export function isOriginAllowed(origin: string | undefined, policy: ReturnType<typeof parseOriginPolicy>): boolean {
  if (!origin) return true
  if (policy.allowAnyOrigin) return true
  return policy.allowedOrigins.has(origin)
}

export function extractClientIp(input: { remoteAddress?: string | null; forwardedFor?: string | null }, trustProxy: boolean): string {
  if (trustProxy && input.forwardedFor) {
    return input.forwardedFor.split(',')[0].trim()
  }
  return input.remoteAddress?.trim() || 'unknown'
}

export function logSecurityEvent(event: {
  surface: string
  action: string
  outcome: 'allow' | 'deny'
  reason?: string
  ip?: string
  origin?: string
}) {
  logger.warn({ security: event }, '[security]')
}
```

- [ ] **Step 5: 把共享 runtime 接入 Koa、terminal、group-chat 和启动日志**

```ts
const authRuntime = await getAuthRuntime()
const originPolicy = parseOriginPolicy(config.corsOrigins)

app.use(cors({
  origin: (ctx) => {
    const origin = ctx.get('Origin') || undefined
    if (!isOriginAllowed(origin, originPolicy)) return ''
    return origin || '*'
  },
}))

app.use(requireAuth(authRuntime))

setupTerminalWebSocket(server, authRuntime, originPolicy)

const groupChatServer = new GroupChatServer(server, authRuntime, originPolicy)

const summary = buildAuthStartupSummary(authRuntime)
console.log(summary.consoleLine)
logger.info(summary.logFields, summary.message)
```

```ts
export function requireAuth(runtime: AuthRuntime) {
  return async (ctx: any, next: () => Promise<void>) => {
    if (runtime.mode === 'insecure-no-auth') {
      await next()
      return
    }

    const auth = ctx.headers.authorization || ''
    const provided = auth.startsWith('Bearer ')
      ? auth.slice(7)
      : (ctx.query.token as string) || ''

    if (provided !== runtime.token) {
      const lowerPath = ctx.path.toLowerCase()
      if (!lowerPath.startsWith('/api') && !lowerPath.startsWith('/v1') && !lowerPath.startsWith('/upload')) {
        await next()
        return
      }
      ctx.status = 401
      ctx.set('Content-Type', 'application/json')
      ctx.body = { error: 'Unauthorized' }
      return
    }

    await next()
  }
}
```

- [ ] **Step 6: 重跑测试确认认证模式与跨协议边界已经统一**

Run: `npx vitest run tests/server/auth.test.ts tests/server/terminal-auth.test.ts tests/server/group-chat.test.ts`

Expected: PASS，且断言以下行为成立：
- `AUTH_DISABLED=1` 无 override 会失败
- 启动摘要不含完整 token
- terminal / group-chat 会拒绝不在 allowlist 的浏览器 `Origin`

- [ ] **Step 7: 提交这一组基础设施改动**

```bash
git add packages/server/src/services/network-security.ts \
  packages/server/src/services/security-events.ts \
  packages/server/src/services/auth.ts \
  packages/server/src/config.ts \
  packages/server/src/index.ts \
  packages/server/src/routes/hermes/terminal.ts \
  packages/server/src/services/hermes/group-chat/index.ts \
  tests/server/auth.test.ts \
  tests/server/terminal-auth.test.ts \
  tests/server/group-chat.test.ts
git commit -m "fix: unify auth mode and origin checks"
```

### Task 2: 收紧下载边界，封住任意绝对路径读取

**Files:**
- Modify: `packages/server/src/services/hermes/file-provider.ts`
- Modify: `packages/server/src/routes/hermes/download.ts`
- Test: `tests/server/download-security.test.ts`

- [ ] **Step 1: 先写下载边界失败测试**

```ts
it('allows relative profile paths', async () => {
  vi.mocked(getTerminalConfig).mockReturnValue({ backend: 'local' })
  vi.mocked(getActiveProfileDir).mockReturnValue('/home/agent/.hermes')

  expect(resolveDownloadRequest('notes/output.txt')).toEqual({
    absolutePath: '/home/agent/.hermes/notes/output.txt',
    backend: 'local',
    useLocalProvider: false,
  })
})

it('allows absolute paths only inside the local upload directory', async () => {
  vi.mocked(getTerminalConfig).mockReturnValue({ backend: 'local' })

  expect(resolveDownloadRequest('/tmp/hermes-uploads/file-1.png')).toEqual({
    absolutePath: '/tmp/hermes-uploads/file-1.png',
    backend: 'local',
    useLocalProvider: true,
  })
})

it('rejects non-whitelist absolute paths on local backend', async () => {
  vi.mocked(getTerminalConfig).mockReturnValue({ backend: 'local' })

  expect(() => resolveDownloadRequest('/etc/passwd')).toThrowErrorMatchingObject({
    code: 'permission_denied',
  })
})

it('rejects client-supplied absolute paths on docker backend', async () => {
  vi.mocked(getTerminalConfig).mockReturnValue({ backend: 'docker' })

  expect(() => resolveDownloadRequest('/workspace/.env')).toThrowErrorMatchingObject({
    code: 'permission_denied',
  })
})
```

- [ ] **Step 2: 运行测试，确认当前下载实现仍然会放行绝对路径**

Run: `npx vitest run tests/server/download-security.test.ts`

Expected: FAIL，至少有一个 case 说明 `/etc/passwd` 或远端 backend 绝对路径没有被拒绝。

- [ ] **Step 3: 在文件服务层实现统一下载授权判断**

```ts
export function resolveDownloadRequest(requestPath: string): {
  absolutePath: string
  backend: BackendType
  useLocalProvider: boolean
} {
  const backend = getTerminalConfig().backend

  if (!requestPath.startsWith('/')) {
    return {
      absolutePath: resolveHermesPath(requestPath),
      backend,
      useLocalProvider: false,
    }
  }

  const absolutePath = validatePath(requestPath)

  if (backend === 'local' && isInUploadDir(absolutePath)) {
    return {
      absolutePath,
      backend,
      useLocalProvider: true,
    }
  }

  throw Object.assign(new Error('Permission denied'), { code: 'permission_denied' })
}
```

- [ ] **Step 4: 下载路由改用新 helper，并补安全审计日志**

```ts
const target = resolveDownloadRequest(filePath)
const provider = target.useLocalProvider ? localProvider : await createFileProvider()
const data = await provider.readFile(target.absolutePath)

ctx.set('Content-Type', mime)
ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`)
ctx.set('Content-Length', String(data.length))
ctx.set('Cache-Control', 'no-cache')
ctx.body = data
```

```ts
if (code === 'permission_denied') {
  logSecurityEvent({
    surface: 'download',
    action: 'read-file',
    outcome: 'deny',
    reason: 'absolute_path_not_allowed',
  })
}
```

- [ ] **Step 5: 重跑下载测试，确认边界与 backend 规则符合 spec**

Run: `npx vitest run tests/server/download-security.test.ts`

Expected: PASS，且能明确区分：
- 相对路径允许
- local uploadDir 绝对路径允许
- 其它绝对路径统一 `403 permission_denied`

- [ ] **Step 6: 提交下载边界修复**

```bash
git add packages/server/src/services/hermes/file-provider.ts \
  packages/server/src/routes/hermes/download.ts \
  tests/server/download-security.test.ts
git commit -m "fix: restrict download paths"
```

### Task 3: 为 `files/upload` 与 `profiles/import` 落地请求体上限和导入路径修复

**Files:**
- Create: `packages/server/src/services/request-body.ts`
- Modify: `packages/server/src/routes/hermes/files.ts`
- Modify: `packages/server/src/controllers/hermes/profiles.ts`
- Test: `tests/server/files-upload.test.ts`
- Test: `tests/server/profiles-import.test.ts`

- [ ] **Step 1: 先写两个入口的失败测试**

```ts
it('returns 413 before provider.writeFile when files/upload exceeds 10 MiB', async () => {
  const provider = { writeFile: vi.fn() }
  vi.mocked(createFileProvider).mockResolvedValue(provider as any)

  const ctx = createMultipartCtx({
    path: 'attachments',
    bodySize: 10 * 1024 * 1024 + 1,
    filename: 'large.bin',
  })

  await uploadHandler(ctx)

  expect(ctx.status).toBe(413)
  expect(ctx.body).toEqual({ error: 'Request body too large', code: 'file_too_large' })
  expect(provider.writeFile).not.toHaveBeenCalled()
})

it('uses a random temp archive name instead of the client filename', async () => {
  const ctx = createImportCtx({
    filename: '../../escape.tar.gz',
    payload: Buffer.from('archive'),
  })

  await importProfile(ctx)

  expect(writeFile).toHaveBeenCalledWith(
    expect.stringMatching(/\/[a-f0-9]{32}\.tar\.gz$/),
    expect.any(Buffer),
  )
})

it('cleans up the temp archive after import failure', async () => {
  vi.mocked(hermesCli.importProfile).mockRejectedValue(new Error('broken archive'))
  const ctx = createImportCtx({
    filename: 'profile.tgz',
    payload: Buffer.from('archive'),
  })

  await importProfile(ctx)

  expect(unlink).toHaveBeenCalled()
})
```

- [ ] **Step 2: 运行测试，确认当前代码仍会整包读入且使用客户端文件名落盘**

Run: `npx vitest run tests/server/files-upload.test.ts tests/server/profiles-import.test.ts`

Expected: FAIL，至少包含以下一种失败：
- `provider.writeFile` 已被调用
- `413` 响应没有稳定错误码
- 临时文件名仍含原始客户端文件名

- [ ] **Step 3: 实现共享的请求体大小限制 helper**

```ts
export async function readRequestBodyWithLimit(
  req: AsyncIterable<Buffer> & { destroy?: () => void },
  options: { maxBytes: number; code: string },
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0

  for await (const chunk of req) {
    total += chunk.length
    if (total > options.maxBytes) {
      req.destroy?.()
      throw Object.assign(new Error('Request body too large'), {
        code: options.code,
        status: 413,
      })
    }
    chunks.push(Buffer.from(chunk))
  }

  return Buffer.concat(chunks)
}
```

- [ ] **Step 4: 为 `files/upload` 接入 10 MiB 总请求体上限并保持“未进入写入路径”**

```ts
const raw = await readRequestBodyWithLimit(ctx.req, {
  maxBytes: config.filesUploadMaxBytes,
  code: 'file_too_large',
})

const parts = splitMultipart(raw, Buffer.from(boundary))
const provider = await createFileProvider()

for (const part of parts) {
  const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
  if (headerEnd === -1) continue
  const header = part.subarray(0, headerEnd).toString('utf-8')
  const data = part.subarray(headerEnd + 4, part.length - 2)

  if (data.length > MAX_EDIT_SIZE) {
    ctx.status = 413
    ctx.body = { error: 'File too large', code: 'file_too_large' }
    return
  }

  await provider.writeFile(absPath, data)
}
```

- [ ] **Step 5: 为 `profiles/import` 接入 100 MiB 上限、随机临时文件名和显式清理**

```ts
const raw = await readRequestBodyWithLimit(ctx.req, {
  maxBytes: config.profilesImportMaxBytes,
  code: 'profile_import_too_large',
})

const archiveExt = getArchiveExtension(filename)
if (!archiveExt) {
  ctx.status = 400
  ctx.body = { error: 'No archive file found (.gz, .zip, .tgz)', code: 'invalid_archive' }
  return
}

const archivePath = join(tmpDir, `${randomBytes(16).toString('hex')}${archiveExt}`)

await writeFile(archivePath, Buffer.from(data, 'binary'))

try {
  const result = await hermesCli.importProfile(archivePath)
  ctx.body = { success: true, message: result.trim() }
} finally {
  await unlink(archivePath).catch(() => {})
}
```

- [ ] **Step 6: 重跑测试，确认两个入口都能早拒绝、稳定返回并清理临时文件**

Run: `npx vitest run tests/server/files-upload.test.ts tests/server/profiles-import.test.ts`

Expected: PASS，尤其要看到以下断言通过：
- `files/upload` 超限后 `provider.writeFile` 从未调用
- `profiles/import` 使用随机文件名
- 导入成功/失败后都执行清理

- [ ] **Step 7: 提交上传/导入边界修复**

```bash
git add packages/server/src/services/request-body.ts \
  packages/server/src/routes/hermes/files.ts \
  packages/server/src/controllers/hermes/profiles.ts \
  tests/server/files-upload.test.ts \
  tests/server/profiles-import.test.ts
git commit -m "fix: add request limits for uploads and imports"
```

### Task 4: 收紧登录面并保持前端兼容

**Files:**
- Create: `packages/server/src/services/login-rate-limit.ts`
- Modify: `packages/server/src/controllers/auth.ts`
- Modify: `packages/client/src/components/hermes/settings/AccountSettings.vue`
- Modify: `packages/client/src/i18n/locales/de.ts`
- Modify: `packages/client/src/i18n/locales/en.ts`
- Modify: `packages/client/src/i18n/locales/es.ts`
- Modify: `packages/client/src/i18n/locales/fr.ts`
- Modify: `packages/client/src/i18n/locales/ja.ts`
- Modify: `packages/client/src/i18n/locales/ko.ts`
- Modify: `packages/client/src/i18n/locales/pt.ts`
- Modify: `packages/client/src/i18n/locales/zh.ts`
- Test: `tests/server/auth-controller.test.ts`
- Test: `tests/client/account-settings.test.ts`

- [ ] **Step 1: 先补控制器与前端兼容性失败测试**

```ts
it('returns username: null from auth status even when password login is configured', async () => {
  vi.mocked(getCredentials).mockResolvedValue({
    username: 'admin',
    password_hash: 'hash',
    salt: 'salt',
    created_at: Date.now(),
  })

  const ctx = createCtx()
  await authStatus(ctx as any)

  expect(ctx.body).toEqual({
    hasPasswordLogin: true,
    username: null,
  })
})

it('rate limits repeated failed logins by remote address', async () => {
  const ctx = createLoginCtx({
    username: 'admin',
    password: 'wrong',
    remoteAddress: '203.0.113.10',
  })

  for (let i = 0; i < 5; i += 1) {
    await login(ctx.factory())
  }

  const blocked = ctx.factory()
  await login(blocked)

  expect(blocked.status).toBe(429)
  expect(blocked.body).toEqual({
    error: 'Too many login attempts',
    code: 'rate_limited',
  })
})

it('ignores x-forwarded-for until TRUST_PROXY is enabled', async () => {
  process.env.TRUST_PROXY = '0'

  const ctx = createLoginCtx({
    username: 'admin',
    password: 'wrong',
    remoteAddress: '203.0.113.10',
    forwardedFor: '198.51.100.24',
  })

  await login(ctx.factory())

  expect(getLimiterSnapshot()).toHaveProperty('203.0.113.10')
  expect(getLimiterSnapshot()).not.toHaveProperty('198.51.100.24')
})
```

```ts
it('renders configured password-login state without showing null username', async () => {
  vi.mocked(fetchAuthStatus).mockResolvedValue({
    hasPasswordLogin: true,
    username: null,
  })

  const wrapper = mount(AccountSettings, {
    global: {
      plugins: [i18n],
      stubs: {
        NButton: true,
        NInput: true,
        NModal: true,
        NForm: true,
        NFormItem: true,
        NPopconfirm: true,
      },
    },
  })

  await flushPromises()

  expect(wrapper.text()).toContain('Password login enabled')
  expect(wrapper.text()).not.toContain('null')
})
```

- [ ] **Step 2: 运行测试，确认当前 `auth/status` 会泄露用户名且登录没有限流**

Run: `npx vitest run tests/server/auth-controller.test.ts tests/client/account-settings.test.ts`

Expected: FAIL，至少包含以下一种失败：
- `auth/status` 返回真实用户名
- 第 6 次失败登录仍返回 `401`
- 前端设置页渲染出 `null` / `()`

- [ ] **Step 3: 实现单进程登录限流器**

```ts
type LoginBucket = {
  count: number
  resetAt: number
}

const WINDOW_MS = 60_000
const MAX_ATTEMPTS = 5
const buckets = new Map<string, LoginBucket>()

export function consumeFailedLogin(ip: string, now = Date.now()) {
  const current = buckets.get(ip)
  if (!current || current.resetAt <= now) {
    const next = { count: 1, resetAt: now + WINDOW_MS }
    buckets.set(ip, next)
    return { allowed: true, retryAfterMs: 0 }
  }

  current.count += 1
  if (current.count > MAX_ATTEMPTS) {
    return { allowed: false, retryAfterMs: current.resetAt - now }
  }

  return { allowed: true, retryAfterMs: 0 }
}

export function resetFailedLogins(ip: string) {
  buckets.delete(ip)
}
```

- [ ] **Step 4: 控制器接入限流、隐藏用户名并输出安全审计日志**

```ts
export async function authStatus(ctx: Context) {
  const cred = await getCredentials()
  ctx.body = {
    hasPasswordLogin: !!cred,
    username: null,
  }
}

export async function login(ctx: Context) {
  const ip = extractClientIp({
    remoteAddress: ctx.req.socket.remoteAddress,
    forwardedFor: ctx.get('x-forwarded-for') || null,
  }, config.trustProxy)

  const { username, password } = ctx.request.body as { username?: string; password?: string }
  if (!username || !password) {
    ctx.status = 400
    ctx.body = { error: 'Username and password are required' }
    return
  }

  const valid = await verifyCredentials(username, password)
  if (!valid) {
    const rate = consumeFailedLogin(ip)
    if (!rate.allowed) {
      ctx.status = 429
      ctx.set('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)))
      ctx.body = { error: 'Too many login attempts', code: 'rate_limited' }
      logSecurityEvent({
        surface: 'auth/login',
        action: 'password-login',
        outcome: 'deny',
        reason: 'rate_limited',
        ip,
      })
      return
    }

    ctx.status = 401
    ctx.body = { error: 'Invalid username or password' }
    return
  }

  resetFailedLogins(ip)
  const token = await getToken()
  ctx.body = { token }
}
```

- [ ] **Step 5: 设置页改成不依赖 `status.username`，并同步所有 locale 的配置提示**

```vue
<div v-else class="configured-section">
  <div class="action-row">
    <span class="action-label">{{ t("login.passwordLoginConfigured") }}</span>
    <div class="action-buttons">
      <NButton @click="openChangePasswordModal">{{ t("login.changePassword") }}</NButton>
      <NButton @click="openChangeUsernameModal">{{ t("login.changeUsername") }}</NButton>
      <NPopconfirm @positive-click="handleRemove">
        <template #trigger>
          <NButton type="error" ghost :loading="loading">{{ t("login.removePasswordLogin") }}</NButton>
        </template>
        {{ t("login.removeConfirm") }}
      </NPopconfirm>
    </div>
  </div>
</div>
```

```ts
passwordLoginConfigured: 'Password login enabled',
```

```ts
passwordLoginConfigured: '密码登录已启用',
```

- [ ] **Step 6: 重跑控制器与前端兼容测试**

Run: `npx vitest run tests/server/auth-controller.test.ts tests/client/account-settings.test.ts`

Expected: PASS，尤其确认：
- `auth/status.username` 固定为 `null`
- 重复失败登录返回 `429 rate_limited`
- 设置页不再展示用户名占位符

- [ ] **Step 7: 提交登录止血与前端兼容改动**

```bash
git add packages/server/src/services/login-rate-limit.ts \
  packages/server/src/controllers/auth.ts \
  packages/client/src/components/hermes/settings/AccountSettings.vue \
  packages/client/src/i18n/locales/de.ts \
  packages/client/src/i18n/locales/en.ts \
  packages/client/src/i18n/locales/es.ts \
  packages/client/src/i18n/locales/fr.ts \
  packages/client/src/i18n/locales/ja.ts \
  packages/client/src/i18n/locales/ko.ts \
  packages/client/src/i18n/locales/pt.ts \
  packages/client/src/i18n/locales/zh.ts \
  tests/server/auth-controller.test.ts \
  tests/client/account-settings.test.ts
git commit -m "fix: harden login endpoints"
```

### Task 5: 同步 README、Docker 文档与登录页 token 获取提示

**Files:**
- Modify: `README.md`
- Modify: `README_zh.md`
- Modify: `docs/docker.md`
- Modify: `packages/client/src/i18n/locales/en.ts`
- Modify: `packages/client/src/i18n/locales/zh.ts`
- Modify: `tests/client/i18n-coverage.test.ts`

- [ ] **Step 1: 先补一个文案回归测试，锁住“不再引导看日志拿 token”**

```ts
it('does not instruct users to read startup logs for the initial token', async () => {
  expect(rawMessages.en.login.description.toLowerCase()).not.toContain('startup logs')
  expect(rawMessages.zh.login.description).not.toContain('启动日志')
})
```

- [ ] **Step 2: 运行 i18n 测试，确认当前文案仍然会失败**

Run: `npx vitest run tests/client/i18n-coverage.test.ts`

Expected: FAIL，因为 `en` / `zh` 登录页文案仍然包含“startup logs / 启动日志”。

- [ ] **Step 3: 更新前端登录文案为新的 token 获取方式**

```ts
description: 'Enter your access token to continue. Read it from ~/.hermes-web-ui/.token on the machine running the server.',
```

```ts
description: '输入访问令牌以继续。请到运行服务的机器上读取 ~/.hermes-web-ui/.token。',
```

- [ ] **Step 4: 更新 README / README_zh / docs/docker.md**

```md
- Token-based auth (auto-generated on first run or set via `AUTH_TOKEN` env var)
- Auth cannot be disabled in public deployments unless `ALLOW_INSECURE_NO_AUTH=1` is also set
- Bare metal: read the initial token from `~/.hermes-web-ui/.token`
- Container shell: read `/root/.hermes-web-ui/.token` inside the container
- Host-mounted data directory: read `./hermes_data/hermes-web-ui/.token` on the host
```

```md
- 基于 Token 的认证（首次运行自动生成，也可通过 `AUTH_TOKEN` 环境变量显式设置）
- 公网部署下不要单独设置 `AUTH_DISABLED=1`；只有同时设置 `ALLOW_INSECURE_NO_AUTH=1` 才允许进入不安全无认证模式
- 裸机部署：从服务所在机器本地读取 `~/.hermes-web-ui/.token`
- 容器内操作：进入容器后读取 `/root/.hermes-web-ui/.token`
- 宿主机挂载目录：在宿主机读取 `./hermes_data/hermes-web-ui/.token`
```

- [ ] **Step 5: 重跑 i18n 测试并用 `rg` 做文档残留检查**

Run: `npx vitest run tests/client/i18n-coverage.test.ts`

Expected: PASS

Run: `rg -n "startup logs|启动日志|grep token" README.md README_zh.md docs/docker.md packages/client/src/i18n/locales/en.ts packages/client/src/i18n/locales/zh.ts`

Expected: no matches

- [ ] **Step 6: 提交文档与文案同步**

```bash
git add README.md \
  README_zh.md \
  docs/docker.md \
  packages/client/src/i18n/locales/en.ts \
  packages/client/src/i18n/locales/zh.ts \
  tests/client/i18n-coverage.test.ts
git commit -m "docs: update token retrieval guidance"
```

### Task 6: 做一轮热修回归验证

**Files:**
- Modify: `docs/superpowers/plans/2026-04-25-security-hotfix-implementation.md`

- [ ] **Step 1: 运行本次热修相关的定向测试集合**

Run: `npx vitest run tests/server/auth.test.ts tests/server/terminal-auth.test.ts tests/server/group-chat.test.ts tests/server/download-security.test.ts tests/server/files-upload.test.ts tests/server/profiles-import.test.ts tests/server/auth-controller.test.ts tests/client/account-settings.test.ts tests/client/i18n-coverage.test.ts`

Expected: PASS

- [ ] **Step 2: 运行完整构建，确保服务端与前端类型/构建都通过**

Run: `npm run build`

Expected: exit code 0，产物正常生成，没有新的 TypeScript / vite 构建错误。

- [ ] **Step 3: 做三条 grep 级静态验收**

Run: `rg -n "Auth enabled — token|token: %s|startup logs|启动日志" packages/server/src README.md README_zh.md docs/docker.md packages/client/src/i18n`

Expected: no matches

Run: `rg -n "origin: '\\*'|origin: '\\*'" packages/server/src/services/hermes/group-chat/index.ts`

Expected: no matches

Run: `rg -n "AUTH_DISABLED=1" README.md README_zh.md docs/docker.md`

Expected: 所有命中都明确说明需要 `ALLOW_INSECURE_NO_AUTH=1` 二次确认，不能再出现“单独设置就可禁用认证”的描述。

- [ ] **Step 4: 在计划文件末尾补一句执行结果摘要，便于后续追踪**

```md
执行记录：
- [ ] Task 1 completed
- [ ] Task 2 completed
- [ ] Task 3 completed
- [ ] Task 4 completed
- [ ] Task 5 completed
- [ ] Task 6 completed
```

## Self-Review

### Spec Coverage

- `5.1 认证模式统一收口` → Task 1
- `5.2 token 泄露面收口` → Task 1 + Task 5 + Task 6
- `5.3 文件下载边界收口` → Task 2
- `5.4 profile 导入路径穿越修复` → Task 3
- `5.5 上传/导入请求体上限` → Task 3
- `5.6 登录面止血` → Task 4
- `6.1/6.3 默认配置与部署建议` → Task 5
- `8.1 自动化测试` → Task 1-5 的测试步骤 + Task 6 汇总回归
- 额外补齐的代码库一致性项：
  - 登录页 token 获取提示不再指向日志 → Task 5
  - `auth/status.username = null` 后设置页不再依赖用户名 → Task 4
  - `docs/docker.md` 去除旧日志取 token 文案 → Task 5

### Placeholder Scan

- 没有使用 `TODO` / `TBD` / “稍后实现”。
- 每个实现步骤都给出了明确文件、命令和核心代码片段。
- 每个测试步骤都给出了明确命令与预期结果。

### Type / Naming Consistency

- 认证运行时统一命名为 `AuthRuntime`。
- origin 统一命名为 `parseOriginPolicy` / `isOriginAllowed`。
- 安全审计日志统一命名为 `logSecurityEvent`。
- 请求体上限 helper 统一命名为 `readRequestBodyWithLimit`。
- 登录限流统一命名为 `consumeFailedLogin` / `resetFailedLogins`。
