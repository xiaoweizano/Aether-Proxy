# resources/

运行时静态资源。构建时由 electron-vite 原样拷贝/由打包配置带入 `process.resourcesPath`。

## tray.png / tray@2x.png

托盘图标，16×16 与 32×32 的 RGBA PNG，**本仓库脚本生成**（不是从设计稿裁剪、
也没有第三方来源）：

- 图形：圆角方块（`--accent` 线蓝 `#4A8CFF`）挖空一个「A」字标记；
  16px 版去掉横杠，否则在通知区域的像素预算下会糊成一团。
- 生成方式：一个一次性的 node 脚本（`deflateSync` 手写 PNG、每像素 12×12 超采样做抗锯齿），
  几何按 32×32 坐标系描述、按目标尺寸缩放，所以两档是同一个标记的两种密度。
- 图标是透明的单色标记；不缩进 `docs/design/`，因为它是运行时资产，
  设计文档里的截图只作展示。

`src/main/index.ts` 从 `tray@2x.png` 加载再按系统 DPI 缩到 `16 × scaleFactor`，
避免通知区域二次采样导致的发虚。
