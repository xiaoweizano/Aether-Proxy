import path from 'node:path'

export function resolveMihomoBinary(input: {
  isPackaged: boolean
  resourcesPath: string
  repoRoot: string
}): string {
  return input.isPackaged
    ? path.join(input.resourcesPath, 'mihomo', 'mihomo.exe')
    : path.join(input.repoRoot, 'vendor', 'mihomo.exe')
}
