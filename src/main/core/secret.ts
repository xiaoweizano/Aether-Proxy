import { randomBytes } from 'node:crypto'

export function newSecret(): string {
  return randomBytes(16).toString('hex')
}
