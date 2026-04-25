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

export async function readRequestBody(ctx: any, limitBytes: number, errorMessage: string, errorCode: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  let totalSize = 0

  for await (const chunk of ctx.req) {
    totalSize += chunk.length
    if (totalSize > limitBytes) {
      if (typeof ctx.req?.destroy === 'function' && !ctx.req.destroyed) {
        ctx.req.destroy()
      }
      throw new RequestBodyTooLargeError(errorMessage, errorCode)
    }
    chunks.push(chunk)
  }

  return Buffer.concat(chunks)
}
