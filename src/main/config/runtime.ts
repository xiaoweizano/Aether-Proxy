import { readFile } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { writeFileAtomic } from './atomic'

const FILE = 'runtime.yaml'

export async function writeRuntime(profileDir: string, config: unknown): Promise<string> {
  const target = path.join(profileDir, FILE)
  await writeFileAtomic(target, YAML.stringify(config))
  return target
}

export async function readRuntime(profileDir: string): Promise<Record<string, unknown> | null> {
  try {
    return YAML.parse(await readFile(path.join(profileDir, FILE), 'utf8')) ?? null
  } catch {
    return null
  }
}
