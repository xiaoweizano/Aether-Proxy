import { randomBytes } from 'node:crypto'
import { rename, unlink, writeFile } from 'node:fs/promises'

export async function writeFileAtomic(target: string, data: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, data, 'utf8')
    await rename(tmp, target)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}
