export class RequestBodyTooLargeError extends Error {
  code: string
  status: number

  constructor(message: string, code: string) {
    super(message)
    this.name = 'RequestBodyTooLargeError'
    this.code = code
    this.status = 413
  }
}

function drainRequest(req: any) {
  if (!req || req.destroyed || req.complete) {
    return
  }
  req.pause?.()
}

function prepareTooLargeResponse(ctx: any) {
  ctx.res.shouldKeepAlive = false
  ctx.set?.('Connection', 'close')
}

export async function readRequestBody(ctx: any, limitBytes: number, errorMessage: string, errorCode: string): Promise<Buffer> {
  const req = ctx.req
  const contentLengthHeader = ctx.get?.('content-length') || req.headers?.['content-length']
  const contentLength = Number(contentLengthHeader)

  if (Number.isFinite(contentLength) && contentLength > limitBytes) {
    prepareTooLargeResponse(ctx)
    drainRequest(req)
    throw new RequestBodyTooLargeError(errorMessage, errorCode)
  }

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalSize = 0
    let settled = false

    const cleanup = () => {
      req.off?.('data', onData)
      req.off?.('end', onEnd)
      req.off?.('error', onError)
      req.off?.('aborted', onAborted)
    }

    const rejectOnce = (error: Error) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(error)
    }

    const onData = (chunk: Buffer | string) => {
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalSize += bufferChunk.length
      if (totalSize > limitBytes) {
        cleanup()
        prepareTooLargeResponse(ctx)
        drainRequest(req)
        rejectOnce(new RequestBodyTooLargeError(errorMessage, errorCode))
        return
      }
      chunks.push(bufferChunk)
    }

    const onEnd = () => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks))
    }

    const onError = (error: Error) => {
      rejectOnce(error)
    }

    const onAborted = () => {
      rejectOnce(new Error('Request aborted'))
    }

    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('aborted', onAborted)
  })
}
