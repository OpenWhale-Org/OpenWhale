export interface Credential {
  id: string
  name: string
  encryptedData: string
  createdAt: string
  updatedAt: string
}

export interface CredentialInfo {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface CredentialStore {
  set(name: string, value: string): Promise<CredentialInfo>
  get(id: string): Promise<string>
  getByName(name: string): Promise<string>
  delete(id: string): Promise<void>
  list(): Promise<CredentialInfo[]>
}
