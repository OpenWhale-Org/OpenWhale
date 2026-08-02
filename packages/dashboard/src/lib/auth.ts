/** Session cookie name — must match the gateway's. */
export const SESSION_COOKIE = 'ow_session'

export interface AuthUser {
  id: string
  username: string
  createdAt: string
}
