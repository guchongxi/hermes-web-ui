import { extractClientIp, parseBooleanFlag } from './network-security'

interface HeaderCarrier {
  headers?: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string | null } | null
  connection?: { remoteAddress?: string | null } | null
}

interface LoginRateLimitOptions {
  trustProxy?: boolean
  now?: number
  maxAttempts?: number
  windowMs?: number
}

export interface LoginRateLimitState {
  ip: string
  limited: boolean
  retryAfterSeconds: number
}

const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_WINDOW_MS = 60_000
const FALLBACK_IP = 'unknown'

const failedAttemptsByIp = new Map<string, number[]>()

function sweepExpiredBuckets(now: number, windowMs: number): void {
  for (const [ip, attempts] of failedAttemptsByIp.entries()) {
    const validAttempts = attempts.filter((timestamp) => now - timestamp < windowMs)
    if (validAttempts.length > 0) {
      failedAttemptsByIp.set(ip, validAttempts)
    } else {
      failedAttemptsByIp.delete(ip)
    }
  }
}

function resolveOptions(options: LoginRateLimitOptions) {
  return {
    trustProxy: options.trustProxy ?? parseBooleanFlag(process.env.TRUST_PROXY),
    now: options.now ?? Date.now(),
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
  }
}

function pruneAttempts(ip: string, now: number, windowMs: number): number[] {
  const attempts = failedAttemptsByIp.get(ip) ?? []
  const validAttempts = attempts.filter((timestamp) => now - timestamp < windowMs)

  if (validAttempts.length > 0) {
    failedAttemptsByIp.set(ip, validAttempts)
  } else {
    failedAttemptsByIp.delete(ip)
  }

  return validAttempts
}

export function getLoginRateLimitIp(requestLike: HeaderCarrier, options: LoginRateLimitOptions = {}): string {
  const { trustProxy } = resolveOptions(options)
  return extractClientIp(requestLike, { trustProxy }) || FALLBACK_IP
}

export function getLoginRateLimitState(
  requestLike: HeaderCarrier,
  options: LoginRateLimitOptions = {},
): LoginRateLimitState {
  const { now, windowMs, maxAttempts } = resolveOptions(options)
  sweepExpiredBuckets(now, windowMs)
  const ip = getLoginRateLimitIp(requestLike, options)
  const attempts = pruneAttempts(ip, now, windowMs)

  if (attempts.length < maxAttempts) {
    return {
      ip,
      limited: false,
      retryAfterSeconds: 0,
    }
  }

  const retryAfterMs = Math.max(windowMs - (now - attempts[0]), 0)

  return {
    ip,
    limited: true,
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  }
}

export function recordFailedLoginAttempt(requestLike: HeaderCarrier, options: LoginRateLimitOptions = {}): void {
  const { now, windowMs } = resolveOptions(options)
  sweepExpiredBuckets(now, windowMs)
  const ip = getLoginRateLimitIp(requestLike, options)
  const attempts = pruneAttempts(ip, now, windowMs)
  attempts.push(now)
  failedAttemptsByIp.set(ip, attempts)
}

export function clearLoginRateLimit(requestLike: HeaderCarrier, options: LoginRateLimitOptions = {}): void {
  const { now, windowMs } = resolveOptions(options)
  sweepExpiredBuckets(now, windowMs)
  const ip = getLoginRateLimitIp(requestLike, options)
  failedAttemptsByIp.delete(ip)
}

export function resetLoginRateLimitStore(): void {
  failedAttemptsByIp.clear()
}
