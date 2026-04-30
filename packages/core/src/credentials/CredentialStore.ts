import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { Credential, CredentialInfo, CredentialStore } from '../types/credential.js'
import { generateId } from '../utils/id.js'
import { readJsonlLines, writeJsonlLines } from '../utils/jsonl.js'

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32

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

export class FileCredentialStore implements CredentialStore {
  private readonly filePath: string
  private readonly key: Buffer

  constructor(masterKey: string, filePath: string) {
    if (Buffer.byteLength(masterKey) === 0) throw new Error('masterKey must not be empty')
    this.key = deriveKey(masterKey)
    this.filePath = filePath
  }

  private async readAll(): Promise<Credential[]> {
    return readJsonlLines<Credential>(this.filePath)
  }

  private async writeAll(credentials: Credential[]): Promise<void> {
    const dir = path.dirname(this.filePath)
    await fs.promises.mkdir(dir, { recursive: true })
    await writeJsonlLines(this.filePath, credentials)
  }

  async set(name: string, value: string): Promise<CredentialInfo> {
    const credentials = await this.readAll()
    const now = new Date().toISOString()
    const existing = credentials.findIndex((c) => c.name === name)

    if (existing !== -1) {
      const updated: Credential = {
        ...credentials[existing]!,
        encryptedData: encrypt(value, this.key),
        updatedAt: now,
      }
      credentials[existing] = updated
      await this.writeAll(credentials)
      return { id: updated.id, name: updated.name, createdAt: updated.createdAt, updatedAt: updated.updatedAt }
    }

    const credential: Credential = {
      id: generateId('cred'),
      name,
      encryptedData: encrypt(value, this.key),
      createdAt: now,
      updatedAt: now,
    }
    credentials.push(credential)
    await this.writeAll(credentials)
    return { id: credential.id, name: credential.name, createdAt: credential.createdAt, updatedAt: credential.updatedAt }
  }

  async get(id: string): Promise<string> {
    const credentials = await this.readAll()
    const credential = credentials.find((c) => c.id === id)
    if (!credential) throw new Error(`Credential not found: ${id}`)
    return decrypt(credential.encryptedData, this.key)
  }

  async getByName(name: string): Promise<string> {
    const credentials = await this.readAll()
    const credential = credentials.find((c) => c.name === name)
    if (!credential) throw new Error(`Credential not found: ${name}`)
    return decrypt(credential.encryptedData, this.key)
  }

  async delete(id: string): Promise<void> {
    const credentials = await this.readAll()
    const filtered = credentials.filter((c) => c.id !== id)
    if (filtered.length === credentials.length) throw new Error(`Credential not found: ${id}`)
    await this.writeAll(filtered)
  }

  async list(): Promise<CredentialInfo[]> {
    const credentials = await this.readAll()
    return credentials.map(({ id, name, createdAt, updatedAt }) => ({ id, name, createdAt, updatedAt }))
  }
}
