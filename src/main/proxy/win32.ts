import koffi from 'koffi'
import type { ProxyState } from '../../shared/types'
import type { PlatformProxy } from './platform'

/**
 * Windows 系统代理读写（HKCU，无需管理员）。
 *
 * 所有 Win32 / koffi 调用只允许出现在本文件。签名已按 koffi 3.x 的
 * 方向标记约定核对：输出标量用 `_Out_ T *`（JS 侧传单元素数组接收），
 * 输入输出标量用 `_Inout_ T *`（先读数组当前值传入，再接收输出）。
 */

const HKEY_CURRENT_USER = 0x80000001
const KEY_QUERY_VALUE = 0x0001
const KEY_SET_VALUE = 0x0002
const REG_SZ = 1
const REG_EXPAND_SZ = 2
const REG_DWORD = 4
const ERROR_FILE_NOT_FOUND = 2
const INTERNET_OPTION_REFRESH = 37
const INTERNET_OPTION_SETTINGS_CHANGED = 39
const SUBKEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

const advapi = koffi.load('advapi32.dll')
const wininet = koffi.load('wininet.dll')

const RegOpenKeyExW = advapi.func(
  'int __stdcall RegOpenKeyExW(uintptr_t hKey, str16 lpSubKey, uint32 ulOptions, uint32 samDesired, _Out_ uintptr_t *phkResult)'
)
const RegCloseKey = advapi.func('int __stdcall RegCloseKey(uintptr_t hKey)')
const RegQueryValueExW = advapi.func(
  'int __stdcall RegQueryValueExW(uintptr_t hKey, str16 lpValueName, void *lpReserved, _Out_ uint32 *lpType, _Out_ uint8_t *lpData, _Inout_ uint32 *lpcbData)'
)
const RegSetValueExW = advapi.func(
  'int __stdcall RegSetValueExW(uintptr_t hKey, str16 lpValueName, uint32 Reserved, uint32 dwType, const uint8_t *lpData, uint32 cbData)'
)
const RegDeleteValueW = advapi.func('int __stdcall RegDeleteValueW(uintptr_t hKey, str16 lpValueName)')
const InternetSetOptionW = wininet.func(
  'int __stdcall InternetSetOptionW(void *hInternet, uint32 dwOption, void *lpBuffer, uint32 dwBufferLength)'
)

function openKey(): number {
  const out: [number] = [0]
  const rc = RegOpenKeyExW(HKEY_CURRENT_USER, SUBKEY, 0, KEY_QUERY_VALUE | KEY_SET_VALUE, out)
  if (rc !== 0) throw new Error(`RegOpenKeyExW 失败：${rc}`)
  return Number(out[0])
}

/**
 * 两段式读取：先用空缓冲区问出所需字节数，再按实际大小分配。
 * 单段固定 4096 字节在值超长时会返回 ERROR_MORE_DATA 并丢掉内容。
 */
function queryValue(hkey: number, name: string): { type: number; data: Buffer } | null {
  const type: [number] = [0]
  let size: [number] = [0]

  let rc = RegQueryValueExW(hkey, name, null, type, null, size)
  if (rc === ERROR_FILE_NOT_FOUND) return null
  if (rc !== 0) throw new Error(`读取 ${name} 失败：${rc}`)

  const required = size[0]
  if (required === 0) return { type: type[0], data: Buffer.alloc(0) }

  const buf = Buffer.alloc(required)
  size = [required]
  rc = RegQueryValueExW(hkey, name, null, type, buf, size)
  if (rc !== 0) throw new Error(`读取 ${name} 失败：${rc}`)

  return { type: type[0], data: buf.subarray(0, Math.min(size[0], required)) }
}

function readString(hkey: number, name: string): string | undefined {
  const raw = queryValue(hkey, name)
  if (!raw || (raw.type !== REG_SZ && raw.type !== REG_EXPAND_SZ)) return undefined
  return raw.data.toString('utf16le').replace(/\0+$/, '')
}

function readDword(hkey: number, name: string): number | undefined {
  const raw = queryValue(hkey, name)
  if (!raw || raw.type !== REG_DWORD || raw.data.length < 4) return undefined
  return raw.data.readUInt32LE(0)
}

function writeString(hkey: number, name: string, value: string): void {
  const data = Buffer.from(`${value}\0`, 'utf16le')
  const rc = RegSetValueExW(hkey, name, 0, REG_SZ, data, data.length)
  if (rc !== 0) throw new Error(`写入 ${name} 失败：${rc}`)
}

function writeDword(hkey: number, name: string, value: number): void {
  const data = Buffer.alloc(4)
  data.writeUInt32LE(value)
  const rc = RegSetValueExW(hkey, name, 0, REG_DWORD, data, 4)
  if (rc !== 0) throw new Error(`写入 ${name} 失败：${rc}`)
}

/** 值不存在时删除是幂等的；只有其它错误才抛出。 */
function deleteValue(hkey: number, name: string): void {
  const rc = RegDeleteValueW(hkey, name)
  if (rc !== 0 && rc !== ERROR_FILE_NOT_FOUND) throw new Error(`删除 ${name} 失败：${rc}`)
}

function broadcast(): void {
  InternetSetOptionW(null, INTERNET_OPTION_SETTINGS_CHANGED, null, 0)
  InternetSetOptionW(null, INTERNET_OPTION_REFRESH, null, 0)
}

export function loadWindowsProxy(): PlatformProxy {
  return {
    async getSystemProxy(): Promise<ProxyState> {
      const hkey = openKey()
      try {
        const bypass = readString(hkey, 'ProxyOverride')
        return {
          enabled: readDword(hkey, 'ProxyEnable') === 1,
          server: readString(hkey, 'ProxyServer'),
          bypass: bypass === undefined ? undefined : bypass.split(';').filter(Boolean),
          autoConfigUrl: readString(hkey, 'AutoConfigURL'),
          // 实测：广播 InternetSetOptionW 之后，Windows 会删除显式的
          // AutoDetect=0（缺省即关闭自动检测）。因此缺省按 false 处理。
          autoDetect: readDword(hkey, 'AutoDetect') === 1
        }
      } finally {
        RegCloseKey(hkey)
      }
    },

    async setSystemProxy({ server, bypass }): Promise<void> {
      const hkey = openKey()
      try {
        writeDword(hkey, 'ProxyEnable', 1)
        writeString(hkey, 'ProxyServer', server)
        writeString(hkey, 'ProxyOverride', bypass.join(';'))
        deleteValue(hkey, 'AutoConfigURL')
        writeDword(hkey, 'AutoDetect', 0)
      } finally {
        RegCloseKey(hkey)
      }
      broadcast()
    },

    async clearSystemProxy(): Promise<void> {
      const hkey = openKey()
      try {
        writeDword(hkey, 'ProxyEnable', 0)
      } finally {
        RegCloseKey(hkey)
      }
      broadcast()
    },

    async restore(state): Promise<void> {
      const hkey = openKey()
      try {
        writeDword(hkey, 'ProxyEnable', state.enabled ? 1 : 0)

        if (state.server === undefined) deleteValue(hkey, 'ProxyServer')
        else writeString(hkey, 'ProxyServer', state.server)

        if (state.bypass === undefined) deleteValue(hkey, 'ProxyOverride')
        else writeString(hkey, 'ProxyOverride', state.bypass.join(';'))

        if (state.autoConfigUrl === undefined) deleteValue(hkey, 'AutoConfigURL')
        else writeString(hkey, 'AutoConfigURL', state.autoConfigUrl)

        if (state.autoDetect === undefined) deleteValue(hkey, 'AutoDetect')
        else writeDword(hkey, 'AutoDetect', state.autoDetect ? 1 : 0)
      } finally {
        RegCloseKey(hkey)
      }
      broadcast()
    }
  }
}
