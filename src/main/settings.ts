import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from './config/atomic'

export interface Settings {
  proxyEnabled: boolean
}

const DEFAULTS: Settings = { proxyEnabled: false }

export async function readSettings(file: string): Promise<Settings> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<Settings>
    return { proxyEnabled: parsed.proxyEnabled === true }
  } catch {
    return { ...DEFAULTS }
  }
}

export async function writeSettings(file: string, settings: Settings): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(settings, null, 2))
}
