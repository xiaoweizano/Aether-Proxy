# build/

electron-builder 的 `buildResources` 目录。这里放**手工维护的构建输入**，不是产物。

## icon.ico

安装包与 `Aether.exe` 的图标，**由本仓库脚本生成**，不是独立设计稿：

- 生成命令：`npm run icon`（`scripts/make-app-icon.mjs`）
- 来源：`resources/tray.png`（16×16）与 `resources/tray@2x.png`（32×32），
  即仓库已有的托盘标记（蓝底圆角方块 + 镂空「A」，说明见 `resources/README.md`）。
  没有第三方素材、没有重新设计。
- 尺寸：16 / 32 / 48 / 64 / 128 / 256。16 与 32 直接使用原图像素；更大的三档由 32px
  原图按预乘 alpha 的 Catmull-Rom 插值放大（源标记没有更大位图）。
- 编码：全部为 ICO 内的 32bpp DIB 条目（Windows Vista+ 也接受 PNG 条目，但 DIB 在
  rcedit、资源管理器、NSIS 里的兼容性最好）。256px 的 DIB 条目约 270 KB，整个
  `icon.ico` 约 370 KB —— 对安装包体积无实质影响。

改图标时请改 `resources/tray*.png` 后重新 `npm run icon`，不要直接改这个二进制文件；
它必须与托盘标记保持同一形状。
