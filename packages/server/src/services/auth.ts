import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { parseBooleanFlag } from './network-security'

const APP_HOME = join(homedir(), '.hermes-web-ui')
const TOKEN_FILE = join(APP_HOME, '.token')

export type AuthRuntime =
  | { mode: 'enabled'; token: string }
  | { mode: 'insecure-no-auth'; token: null }

function generateToken(): string {
  return randomBytes(32).toString('hex')
}

async function getOrCreateToken(): Promise<string> {
  if (process.env.AUTH_TOKEN) {
    return process.env.AUTH_TOKEN
  }

  try {
    const token = await readFile(TOKEN_FILE, 'utf-8')
    return token.trim()
  } catch {
    const token = generateToken()
    await mkdir(APP_HOME, { recursive: true })
    await writeFile(TOKEN_FILE, token + '\n', { mode: 0o600 })
    return token
  }
}

export async function getAuthRuntime(): Promise<AuthRuntime> {
  const authDisabled = parseBooleanFlag(process.env.AUTH_DISABLED)
  const allowInsecureNoAuth = parseBooleanFlag(process.env.ALLOW_INSECURE_NO_AUTH)

  if (authDisabled) {
    if (!allowInsecureNoAuth) {
      throw new Error('AUTH_DISABLED requires ALLOW_INSECURE_NO_AUTH=1|true before startup can continue')
    }

    return {
      mode: 'insecure-no-auth',
      token: null,
    }
  }

  return {
    mode: 'enabled',
    token: await getOrCreateToken(),
  }
}

export async function getToken(): Promise<string | null> {
  const runtime = await getAuthRuntime()
  return runtime.token
}

export function describeAuthRuntime(runtime: AuthRuntime): string {
  if (runtime.mode === 'enabled') {
    return 'Auth enabled'
  }

  return 'WARNING: running in insecure-no-auth mode'
}

export function isTokenAuthorized(runtime: AuthRuntime, providedToken: string | null | undefined): boolean {
  if (runtime.mode === 'insecure-no-auth') {
    return true
  }

  return Boolean(providedToken) && providedToken === runtime.token
}

function getBearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ')) {
    return ''
  }
  return authorization.slice(7)
}

/**
 * Koa middleware: check Authorization header or query token.
 * No path whitelisting — applied globally after public routes.
 */
export function requireAuth(runtime: AuthRuntime) {
  return async (ctx: any, next: () => Promise<void>) => {
    if (runtime.mode === 'insecure-no-auth') {
      await next()
      return
    }

    const provided = getBearerToken(ctx.headers.authorization) || (ctx.query.token as string) || ''

    if (!isTokenAuthorized(runtime, provided)) {
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
