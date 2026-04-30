import { nanoid } from 'nanoid'

export function generateId(prefix: string): string {
  return `${prefix}_${nanoid(10)}`
}
