## ADDED Requirements

### Requirement: 启用系统代理

系统 SHALL 将 Windows 系统代理指向本地 mixed-port 地址，并设置 `ProxyOverride` 至少包含 `localhost`、`127.0.0.0/8`、`::1` 与局域网网段。启用后 MUST 调用 WinINet 广播设置变更。

#### Scenario: 开启代理

- **WHEN** 用户开启系统代理
- **THEN** 注册表 `ProxyEnable` 为 1、`ProxyServer` 为本机 `127.0.0.1:<mixed-port>`、`ProxyOverride` 含回环与局域网，且变更已广播

### Requirement: PAC 与自动检测处理

系统 MUST 在启用代理时删除 `AutoConfigURL` 并将 `AutoDetect` 置 0，避免自动配置覆盖手动代理；还原时按快照恢复这两项。

#### Scenario: 机器原本使用 PAC

- **WHEN** 启用前系统使用 `AutoConfigURL`
- **THEN** 启用后该值被清除且自动检测关闭；关闭代理后原值被写回

### Requirement: 原状态快照

系统 MUST 在修改任何系统代理设置之前，把完整原状态（`enabled`、`server`、`bypass`、`autoConfigUrl`、`autoDetect`）连同 `owner: aether` 标记、pid 与时间戳写入 `proxy-state.json`。

#### Scenario: 快照完整性

- **WHEN** 用户开启代理
- **THEN** `proxy-state.json` 同时包含代理地址与 PAC 相关字段，且写入成功后才修改注册表

### Requirement: 还原系统代理

系统 SHALL 在关闭代理、正常退出、以及检测到残留时，按快照还原全部字段。还原完成后 MUST 删除标记文件。

#### Scenario: 正常关闭代理

- **WHEN** 用户关闭系统代理
- **THEN** 注册表恢复到启用前的完整状态，标记文件被删除

#### Scenario: 启动时发现残留

- **WHEN** 应用启动时发现标记文件存在且不属于本次进程
- **THEN** 自动还原为快照状态，并提示「已恢复上次的系统代理设置」

#### Scenario: 状态已被他人修改

- **WHEN** 标记文件存在，但当前系统代理值与快照不一致
- **THEN** 不覆盖当前设置，仅提示并清除标记文件

### Requirement: 关机与注销清理

系统 SHALL 监听系统关机与注销事件，尽力在退出前还原系统代理。

#### Scenario: 系统关机

- **WHEN** 操作系统发出关机或注销信号
- **THEN** 应用尝试还原代理并终止内核；未完成时，由下次启动的残留检测兜底

### Requirement: 权限模型

系统的 Windows 实现 MUST NOT 要求管理员权限，也不得触发 UAC。

#### Scenario: 普通用户账户

- **WHEN** 非管理员用户在 M1 中开启系统代理
- **THEN** 代理设置成功生效，且全程没有 UAC 弹窗
