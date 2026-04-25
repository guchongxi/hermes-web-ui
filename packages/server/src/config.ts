import { resolve } from 'path'
import { tmpdir } from 'os'
import { parseBooleanFlag, parseCorsOrigins } from './services/network-security'

export const config = {
  port: parseInt(process.env.PORT || '8648', 10),
  upstream: process.env.UPSTREAM || 'http://127.0.0.1:8642',
  uploadDir: process.env.UPLOAD_DIR || resolve(tmpdir(), 'hermes-uploads'),
  dataDir: resolve(__dirname, '..', 'data'),
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS || '*'),
  trustProxy: parseBooleanFlag(process.env.TRUST_PROXY),
}
