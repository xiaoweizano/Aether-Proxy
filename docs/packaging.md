# 打包（Windows x64）

electron-builder 配置在仓库根目录的 `electron-builder.yml`，不在 `package.json` 里。
v1 只打 Windows x64；macOS / Linux 的打包目标**尚未配置**（不是漏配，是还没做）。

## 生成

```bash
npm run dist        # 便携目录 + NSIS 安装包（两个目标一起出）
npm run dist:dir    # 只出便携目录，迭代时更快
npm run icon        # 只重新生成 build/icon.ico（改过托盘图标后需要）
```

`dist` / `dist:dir` 会先跑 `electron-vite build`，再调 electron-builder。

**首次构建需要联网**：electron-builder 会下载对应版本的 Electron、NSIS、7-Zip 到
`%LOCALAPPDATA%\electron-builder\Cache`。若 GitHub 直连不可达，用环境变量把代理只传给
这一次构建（不要把代理写进配置或 `.npmrc`，那会影响别人）：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 npm run dist
```

## 产物落点

| 路径 | 说明 | 实测体积（0.1.0） |
|---|---|---|
| `dist/win-unpacked/` | 免安装目录，双击 `Aether.exe` 直接运行 | 440 MB |
| `dist/win-unpacked/Aether.exe` | 主程序（Electron 载体） | 239 MB |
| `dist/Aether-0.1.0-setup.exe` | NSIS 安装包，可自选安装目录、非全家桶、不需要管理员 | 136 MB |
| `dist/Aether-0.1.0-setup.exe.blockmap` | 增量更新用的块表 | 147 KB |

`dist/` 已在 `.gitignore` 里，产物不入库。

## 包里装了什么

```
win-unpacked/
  Aether.exe
  resources/
    app.asar                  # 应用代码（out/ 三个目标 + 生产依赖）
    app.asar.unpacked/        # 原生模块：koffi 不能从 asar 里 dlopen
    mihomo/mihomo.exe         # 内核，extraResources；子进程只能从真实路径 spawn
    geodata/                  # Country.mmdb / geosite.dat / SHA256SUMS
    resources/tray*.png       # 托盘图标
```

上面四个路径不是随意摆的，与源码里的解析器逐一对应：

- `src/main/core/binary.ts` → `<resourcesPath>/mihomo/mihomo.exe`
- `src/main/bootstrap.ts` → `<resourcesPath>/geodata`（`ensureGeodata` 还要读 `SHA256SUMS`）
- `src/main/index.ts` 的 `trayIconDir()` → `<resourcesPath>/resources`

改其中任何一个路径时，**两边一起改**；`binary.test.ts` / `geodata.test.ts` 只覆盖了解析器，
覆盖不到 yml 里的 `extraResources`。

## 刻意没有的东西

- **代码签名 / 公证**：v1 不发证书。exe 与安装包均为未签名，Windows SmartScreen 会拦一次。
- **自动更新**：不接。`electron-builder.yml` 里 `publish: null`，不会生成 `latest.yml`。
- **TUN / 提权**：v1 只有系统代理，安装包非 perMachine、不请求管理员权限。
- **卸载保留用户数据**：`deleteAppDataOnUninstall: false`，配置留在 `%APPDATA%\aether-proxy`。

## 图标

`build/icon.ico` 由 `npm run icon` 从 `resources/tray*.png` 生成（16/32 用原像素，
更大尺寸由 32px 原图放大），不是独立设计资源。来源与取舍见 `build/README.md`。

## 打包后自测（会碰真实系统的地方）

打包版的以下行为与开发态不同，自测时注意：

1. **开机自启**：打包态首次运行会真的写
   `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`（开发态永不写）。
   自测前把隔离 profile 的 `settings.json` 写成 `{"proxyEnabled":false,"autostart":false}`，
   否则会留下启动项。
2. **系统代理**：`proxyEnabled: true` 且内核启动成功时会改写系统代理注册表。
   自测用 `proxyEnabled: false` 的隔离 profile。
3. **userData**：始终加 `--user-data-dir=<临时目录>`，不要碰
   `%APPDATA%\aether-proxy`。
4. **结束进程**：用 `taskkill /F /T /PID <Aether 主进程 pid>` 按 PID 杀。
   **不要**用 `/IM mihomo.exe`——这台机器上可能还跑着别家客户端的内核，按镜像名杀会误伤。
5. **内存闸门**：`npm run measure:memory` 只认打包版（进程名 `Aether.exe`）。
   窗口最小化/关到托盘后再测才是常驻状态的数字。

## 已知结果（0.1.0，第一次实测）

在隔离 profile 下启动 `dist/win-unpacked/Aether.exe`，窗口正常渲染、托盘图标出现、
内核从 `resources/mihomo/mihomo.exe` 拉起、geodata 从 `resources/geodata` 校验并复制到
profile 目录（哈希与 `vendor/geodata/SHA256SUMS` 一致）。

关掉主窗口（托盘常驻状态）后测得 **273.8 MB / 150 MB 预算**：主进程 107.6 MB、
GPU 89.7 MB、渲染进程已销毁、utility 49.7 MB、mihomo 26.8 MB。
**超出预算**，需要后续单独处理（见报告）。
