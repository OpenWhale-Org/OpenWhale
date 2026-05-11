export interface Credential {
  id: string
  name: string
  type: string
  encryptedData: string
  createdAt: string
  updatedAt: string
}

export interface CredentialInfo {
  id: string
  name: string
  type: string
  createdAt: string
  updatedAt: string
}

export type RawCredentialData = Record<string, unknown>

export interface CredentialData {
  type: string
  data: RawCredentialData
}

export interface CredentialStore {
  set(name: string, type: string, data: RawCredentialData): Promise<CredentialInfo>
  getByName(name: string): Promise<CredentialData>
  delete(id: string): Promise<void>
  list(): Promise<CredentialInfo[]>
}
