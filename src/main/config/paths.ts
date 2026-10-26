import { mkdir } from 'node:fs/promises'
import path from 'node:path'

export async function createProfile(rootDir: string, id: string) {
  const dir = path.join(rootDir, 'profiles', id)
  await mkdir(dir, { recursive: true })
  return { dir, upstreamPath: path.join(dir, 'upstream.yaml') }
}
