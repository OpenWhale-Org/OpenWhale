import crypto from 'crypto'
import type { Credential, CredentialInfo, CredentialStore } from '../types/credential.js'
import type { DatabaseAdapter } from '../database/DatabaseAdapter.js'
import { generateId } from '../utils/id.js'

const ALGORITHM = 'aes-256-gcm'

function deriveKey(masterKey: string): Buffer {
  return crypto.createHash('sha256').update(masterKey).digest()
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':')
}

function decrypt(encoded: string, key: Buffer): string {
  const parts = encoded.split(':')
  if (parts.length !== 3) throw new Error('Invalid credential format')
  const [ivHex, authTagHex, encryptedHex] = parts
  if (!ivHex || !authTagHex || !encryptedHex) throw new Error('Invalid credential format')
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const encrypted = Buffer.from(encryptedHex, 'hex')
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8')
}

interface CredentialRow {
  [key: string]: unknown
  id: string
  name: string
  encrypted_data: string
  created_at: string
  updated_at: string
}

export class DBCredentialStore implements CredentialStore {
  private readonly key: Buffer

  constructor(masterKey: string, private readonly db: DatabaseAdapter) {
    if (Buffer.byteLength(masterKey) === 0) throw new Error('masterKey must not be empty')
    this.key = deriveKey(masterKey)
  }

  async set(name: string, value: string): Promise<CredentialInfo> {
    const now = new Date().toISOString()
    const existing = await this.db.get<CredentialRow>(
      'SELECT * FROM credentials WHERE name = ?',
      [name]
    )

    if (existing) {
      await this.db.run(
        'UPDATE credentials SET encrypted_data = ?, updated_at = ? WHERE id = ?',
        [encrypt(value, this.key), now, existing.id]
      )
      return { id: existing.id, name, createdAt: existing.created_at, updatedAt: now }
    }

    const id = generateId('cred')
    await this.db.run(
      'INSERT INTO credentials (id, name, encrypted_data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [id, name, encrypt(value, this.key), now, now]
    )
    return { id, name, createdAt: now, updatedAt: now }
  }

  async get(id: string): Promise<string> {
    const row = await this.db.get<CredentialRow>('SELECT * FROM credentials WHERE id = ?', [id])
    if (!row) throw new Error(`Credential not found: ${id}`)
    return decrypt(row.encrypted_data, this.key)
  }

  async getByName(name: string): Promise<string> {
    const row = await this.db.get<CredentialRow>('SELECT * FROM credentials WHERE name = ?', [name])
    if (!row) throw new Error(`Credential not found: ${name}`)
    return decrypt(row.encrypted_data, this.key)
  }

  async delete(id: string): Promise<void> {
    const changes = await this.db.run('DELETE FROM credentials WHERE id = ?', [id])
    if (changes === 0) throw new Error(`Credential not found: ${id}`)
  }

  async list(): Promise<CredentialInfo[]> {
    const rows = await this.db.all<CredentialRow>(
      'SELECT id, name, created_at, updated_at FROM credentials ORDER BY name ASC'
    )
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at }))
  }
}
