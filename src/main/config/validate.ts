import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export async function validateConfig(
  binary: string,
  homeDir: string,
  configPath: string,
  argsPrefix: string[] = []
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await run(binary, [...argsPrefix, '-t', '-d', homeDir, '-f', configPath], {
      windowsHide: true,
      timeout: 15_000
    })
    return { ok: true, output: `${stdout}${stderr}` }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string }
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message}` }
  }
}
