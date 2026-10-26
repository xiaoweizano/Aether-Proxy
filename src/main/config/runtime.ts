import { randomBytes } from 'node:crypto'
import { readFile, rename, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'

const FILE = 'runtime.yaml'

export async function writeRuntime(profileDir: string, config: unknown): Promise<string> {
  const target = path.join(profileDir, FILE)
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, YAML.stringify(config), 'utf8')
    await rename(tmp, target)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
  return target
}

export async function readRuntime(profileDir: string): Promise<Record<string, unknown> | null> {
  try {
    return YAML.parse(await readFile(path.join(profileDir, FILE), 'utf8')) ?? null
  } catch {
    return null
  }
}
