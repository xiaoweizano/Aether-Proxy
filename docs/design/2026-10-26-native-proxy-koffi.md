# 设计变更：Windows 原生层由 Rust/napi-rs 改为 koffi Node-FFI

生成于 2026-10-26
Supersedes: `docs/design/2026-10-23-aether-proxy.md` 中的 D20（原生层实现）
状态：APPROVED

## 为什么改

原决策（D20）用 Rust + napi-rs 实现 Windows 系统代理，理由是进程内、无 IPC、运行时稳定。

执行 Task 10 时发现环境事实：本机没有 `cargo` / `rustc`，也没有 MSVC Build Tools 或 MinGW。Rust 本身可装，但 napi-rs 在 Windows 上还需要链接器，补齐方式是 Visual Studio Build Tools（约 3-5 GB、需要管理员、20-40 分钟）。对一个尚未发布的 M1 底座，这个代价不成比例。

## 改了什么

| 维度 | 原方案 | 现方案 |
|---|---|---|
| 语言 | Rust + napi-rs | TypeScript + koffi（Node-FFI，预编译二进制） |
| 构建 | `cargo build` + 复制 `.node` | 无构建步骤，`npm install` 即可 |
| 调用方式 | 进程内 addon | 进程内 FFI 调用 advapi32 / wininet |
| 打包 | 需要随包 `.node` | 需要确保 koffi 的原生二进制不被 ASAR 打包破坏 |

接口不变：`PlatformProxy` 的 `getSystemProxy` / `setSystemProxy` / `clearSystemProxy` / `restore` 与 Task 9 完全一致，`SystemProxyController` 与 `ProxyOwnership` 不受影响。

## 什么没变

- 写入 `HKCU\...\Internet Settings`，全程不需要管理员权限，不触发 UAC。
- 必须处理 `ProxyEnable` / `ProxyServer` / `ProxyOverride`，并删除 `AutoConfigURL`、置 `AutoDetect=0`，再广播 `InternetSetOptionW`。
- 快照与还原契约（Task 9/9A）不变。

## 风险与缓解

- **FFI 签名写错会直接崩主进程。** 缓解：所有调用集中在 `src/main/proxy/win32.ts`，并用 `scripts/proxy-check.mjs` 做一次真实注册表往返验证（读完即还原）。
- **koffi 是原生依赖。** 缓解：M1 不打包发布；打包时（M1.5）把 koffi 的 `build/` 目录排除出 ASAR，并在 CI 里跑一次真实读写。
- **偏离已锁定决策。** 缓解：本文件即记录；若将来要做独立守护进程（Approach C），可以重新评估是否用 Rust 重写这一层，接口不需要变。

## 验证方式

`node scripts/proxy-check.mjs`：

1. 读出当前代理状态并打印；
2. 设为本机 `127.0.0.1:<port>`，回读确认；
3. 无论成功失败，恢复原状态并再次回读确认。

任何一步失败都不算完成。
