import { logger } from './logger'

type PlainObject = Record<string, unknown>

const REDACTED_KEYS = new Set([
  'authorization',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
])

function hasSensitiveQueryParam(value: string): boolean {
  return /(?:^|[?&])(token|access_token|refresh_token|id_token)=/i.test(value)
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value, 'http://localhost')
    for (const key of REDACTED_KEYS) {
      url.searchParams.delete(key)
    }
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return value.replace(/([?&])(token|access_token|refresh_token|id_token)=[^&]*/gi, '')
  }
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return hasSensitiveQueryParam(value) ? sanitizeUrl(value) : value
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item))
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const sanitizedEntries = Object.entries(value as PlainObject)
    .filter(([key]) => !REDACTED_KEYS.has(key.toLowerCase()))
    .map(([key, entryValue]) => [key, sanitizeValue(entryValue)])

  return Object.fromEntries(sanitizedEntries)
}

function sanitizeObject(details: PlainObject): PlainObject {
  return sanitizeValue(details) as PlainObject
}

export function logSecurityEvent(event: string, details: PlainObject = {}): void {
  logger.warn({
    event,
    ...sanitizeObject(details),
  }, `[security] ${event}`)
}
