export interface CorsOriginPolicy {
  raw: string
  allowAny: boolean
  allowedOrigins: string[]
}

interface HeaderCarrier {
  headers?: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string | null } | null
  connection?: { remoteAddress?: string | null } | null
}

interface ClientIpOptions {
  trustProxy?: boolean
}

export function parseBooleanFlag(value: string | undefined | null): boolean {
  return value === '1' || value === 'true'
}

export function parseCorsOrigins(rawValue: string | undefined | null): CorsOriginPolicy {
  const raw = (rawValue || '*').trim() || '*'
  if (raw === '*') {
    return {
      raw,
      allowAny: true,
      allowedOrigins: [],
    }
  }

  return {
    raw,
    allowAny: false,
    allowedOrigins: raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  }
}

export function isOriginAllowed(policy: CorsOriginPolicy, origin: string | null | undefined): boolean {
  if (!origin) {
    return true
  }
  if (policy.allowAny) {
    return true
  }
  return policy.allowedOrigins.includes(origin)
}

export function getKoaCorsOrigin(policy: CorsOriginPolicy, origin: string | null | undefined): string {
  if (policy.allowAny) {
    return '*'
  }
  if (!origin) {
    return policy.allowedOrigins[0] || ''
  }
  return isOriginAllowed(policy, origin) ? origin : ''
}

export function getSocketIoCorsOrigin(policy: CorsOriginPolicy): string | string[] {
  return policy.allowAny ? '*' : policy.allowedOrigins
}

export function getRequestOrigin(requestLike: HeaderCarrier): string | null {
  const originHeader = requestLike.headers?.origin
  if (Array.isArray(originHeader)) {
    return originHeader[0] || null
  }
  return originHeader || null
}

export function extractClientIp(requestLike: HeaderCarrier, options: ClientIpOptions = {}): string {
  if (options.trustProxy) {
    const forwardedFor = requestLike.headers?.['x-forwarded-for']
    const firstForwarded = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor
    if (firstForwarded) {
      const firstIp = firstForwarded.split(',')[0]?.trim()
      if (firstIp) {
        return firstIp
      }
    }
  }

  return requestLike.socket?.remoteAddress
    || requestLike.connection?.remoteAddress
    || ''
}
