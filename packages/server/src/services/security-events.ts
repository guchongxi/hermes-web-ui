import { logger } from './logger'

type PlainObject = Record<string, unknown>

const REDACTED_KEYS = new Set([
  'authorization',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
])

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value, 'http://localhost')
    url.searchParams.delete('token')
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return value.replace(/([?&])token=[^&]*/gi, '$1token=[REDACTED]')
  }
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeUrl(value)
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

export function logSecurityEvent(event: string, details: PlainObject = {}): void {
  logger.warn({
    event,
    ...sanitizeValue(details),
  }, `[security] ${event}`)
}
