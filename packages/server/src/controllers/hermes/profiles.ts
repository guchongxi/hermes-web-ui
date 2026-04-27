import { randomUUID } from 'crypto'
import { createReadStream, existsSync, unlinkSync, writeFileSync } from 'fs'
import { mkdir, unlink, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { tmpdir } from 'os'
import * as hermesCli from '../../services/hermes/hermes-cli'
import { drainPendingSessionDeletes } from '../../services/hermes/group-chat'
import { getGatewayManagerInstance } from '../../services/gateway-bootstrap'
import { logger } from '../../services/logger'
import { RequestBodyTooLargeError, readRequestBody } from '../../services/request-body'

const MAX_PROFILE_IMPORT_REQUEST_SIZE = 100 * 1024 * 1024
const SUPPORTED_ARCHIVE_SUFFIXES = ['.tar.gz', '.tgz', '.zip', '.gz'] as const

function getSupportedArchiveSuffix(filename: string): string | null {
  const lowerFilename = filename.toLowerCase()
  for (const suffix of SUPPORTED_ARCHIVE_SUFFIXES) {
    if (lowerFilename.endsWith(suffix)) {
      return suffix
    }
  }
  return null
}

export async function list(ctx: any) {
  try {
    const profiles = await hermesCli.listProfiles()
    ctx.body = { profiles }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function create(ctx: any) {
  const { name, clone } = ctx.request.body as { name?: string; clone?: boolean }
  if (!name) {
    ctx.status = 400
    ctx.body = { error: 'Missing profile name' }
    return
  }
  try {
    const output = await hermesCli.createProfile(name, clone)
    const mgr = getGatewayManagerInstance()
    if (mgr) {
      try { await mgr.start(name) } catch (err: any) {
        logger.error(err, 'Failed to start gateway for profile "%s"', name)
      }
    }
    ctx.body = { success: true, message: output.trim() }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function get(ctx: any) {
  try {
    const profile = await hermesCli.getProfile(ctx.params.name)
    ctx.body = { profile }
  } catch (err: any) {
    ctx.status = err.message.includes('not found') ? 404 : 500
    ctx.body = { error: err.message }
  }
}

export async function remove(ctx: any) {
  const { name } = ctx.params
  if (name === 'default') {
    ctx.status = 400
    ctx.body = { error: 'Cannot delete the default profile' }
    return
  }
  try {
    const mgr = getGatewayManagerInstance()
    if (mgr) { try { await mgr.stop(name) } catch { } }
    const ok = await hermesCli.deleteProfile(name)
    if (ok) {
      ctx.body = { success: true }
    } else {
      ctx.status = 500
      ctx.body = { error: 'Failed to delete profile' }
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function rename(ctx: any) {
  const { new_name } = ctx.request.body as { new_name?: string }
  if (!new_name) {
    ctx.status = 400
    ctx.body = { error: 'Missing new_name' }
    return
  }
  try {
    const ok = await hermesCli.renameProfile(ctx.params.name, new_name)
    if (ok) {
      ctx.body = { success: true }
    } else {
      ctx.status = 500
      ctx.body = { error: 'Failed to rename profile' }
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function switchProfile(ctx: any) {
  const { name } = ctx.request.body as { name?: string }
  if (!name) {
    ctx.status = 400
    ctx.body = { error: 'Missing profile name' }
    return
  }
  try {
    const output = await hermesCli.useProfile(name)
    await new Promise(r => setTimeout(r, 1000))
    const mgr = getGatewayManagerInstance()
    if (mgr) { mgr.setActiveProfile(name) }
    try {
      const detail = await hermesCli.getProfile(name)
      logger.debug('Profile detail.path = %s', detail.path)
      if (!existsSync(join(detail.path, 'config.yaml'))) {
        try { await hermesCli.setupReset() } catch { }
      }
      const profileEnv = join(detail.path, '.env')
      if (!existsSync(profileEnv)) {
        writeFileSync(profileEnv, '# Hermes Agent Environment Configuration\n', 'utf-8')
        logger.info('Created .env for: %s', detail.path)
      }
    } catch (err: any) {
      logger.error(err, 'Ensure config failed')
    }
    const drainResult = await drainPendingSessionDeletes(name)
    logger.info('[switchProfile] drain result for profile "%s": %d deleted, %d failed', name, drainResult.deleted.length, drainResult.failed.length)
    if (drainResult.failed.length > 0) {
      logger.warn({ profile: name, failed: drainResult.failed }, 'Failed to drain some pending session deletes after profile switch')
    }
    ctx.body = {
      success: true,
      message: output.trim(),
      drained_session_deletes: drainResult.deleted.length,
      failed_session_deletes: drainResult.failed.length,
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function exportProfile(ctx: any) {
  const { name } = ctx.params
  const outputPath = join(tmpdir(), `hermes-profile-${name}.tar.gz`)
  try {
    await hermesCli.exportProfile(name, outputPath)
    if (!existsSync(outputPath)) {
      ctx.status = 500
      ctx.body = { error: 'Export file not found' }
      return
    }
    const filename = basename(outputPath)
    ctx.set('Content-Disposition', `attachment; filename="${filename}"`)
    ctx.set('Content-Type', 'application/gzip')
    ctx.body = createReadStream(outputPath)
    ctx.res.on('finish', () => { try { unlinkSync(outputPath) } catch { } })
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function importProfile(ctx: any) {
  const contentType = ctx.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data')) {
    ctx.status = 400
    ctx.body = { error: 'Expected multipart/form-data' }
    return
  }
  const boundary = '--' + contentType.split('boundary=')[1]
  if (!boundary || boundary === '--undefined') {
    ctx.status = 400
    ctx.body = { error: 'Missing boundary' }
    return
  }
  let rawBody: Buffer
  try {
    rawBody = await readRequestBody(
      ctx,
      MAX_PROFILE_IMPORT_REQUEST_SIZE,
      'Profile import request body too large',
      'profile_import_too_large',
    )
  } catch (err: any) {
    if (err instanceof RequestBodyTooLargeError) {
      ctx.status = err.status
      ctx.body = { error: err.message, code: err.code }
      return
    }
    throw err
  }

  const tmpDir = join(tmpdir(), 'hermes-import')
  await mkdir(tmpDir, { recursive: true })
  const body = rawBody.toString('latin1')
  const parts = body.split(boundary).slice(1, -1)
  let archivePath = ''
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd === -1) continue
    const header = part.substring(0, headerEnd)
    const data = part.substring(headerEnd + 4, part.length - 2)
    const filenameMatch = header.match(/filename="([^"]+)"/)
    if (!filenameMatch) continue
    const filename = filenameMatch[1]
    const suffix = getSupportedArchiveSuffix(filename)
    if (!suffix) continue
    archivePath = join(tmpDir, `${randomUUID()}${suffix}`)
    await writeFile(archivePath, Buffer.from(data, 'binary'))
    break
  }
  if (!archivePath) {
    ctx.status = 400
    ctx.body = { error: 'No archive file found (.gz, .zip, .tgz)' }
    return
  }
  try {
    const result = await hermesCli.importProfile(archivePath)
    ctx.body = { success: true, message: result.trim() }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  } finally {
    try {
      await unlink(archivePath)
    } catch { }
  }
}
