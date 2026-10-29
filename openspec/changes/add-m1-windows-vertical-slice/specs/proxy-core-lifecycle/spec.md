## ADDED Requirements

### Requirement: 内核启动与端点分配

系统 SHALL 在启用代理时拉起 mihomo sidecar。启动前 MUST 为 `mixed-port` 与 `external-controller` 分配当前空闲的本地端口，并每次生成随机 controller secret。secret MUST 只保存在主进程内，不得通过 IPC 下发渲染进程。

#### Scenario: 首次启动内核

- **WHEN** 用户导入配置后开启代理
- **THEN** 主进程分配两个空闲端口、生成随机 secret、写入 `runtime.yaml`，启动 mihomo 并完成 `/version` 握手

#### Scenario: 默认端口被占用

- **WHEN** 期望使用的端口已被其它程序占用
- **THEN** 应用改用其它空闲端口继续启动，不静默失败，也不影响其它程序的监听

### Requirement: 健康检查

系统 SHALL 周期检查内核可用性。连续 3 次健康检查失败时，MUST 将内核标记为不可用并展示可操作的错误状态。

#### Scenario: 内核无响应

- **WHEN** 内核进程存在但 `/version` 连续 3 次请求失败或超时
- **THEN** 界面进入「内核不可用」状态，显示错误摘要与日志入口

### Requirement: 崩溃重启与退避

系统 SHALL 在内核意外退出时自动重启，退避间隔为 1s / 2s / 4s，10 分钟内最多 3 次。用户主动退出后 MUST NOT 再重启内核。

#### Scenario: 内核意外退出

- **WHEN** mihomo 进程非用户操作地退出
- **THEN** 应用在 1 秒后重启内核，界面显示重连状态

#### Scenario: 连续崩溃

- **WHEN** 10 分钟内发生第 4 次崩溃
- **THEN** 停止自动重启，进入错误状态并提供「手动重启」

### Requirement: 孤儿内核识别

系统 SHALL 在启动时检查上次记录的 controller 端口。若端口被占用，MUST 用上次保存的 secret 请求 `/version` 并比对配置哈希，据此区分「上次遗留的内核」与「其它程序」。

#### Scenario: 识别为遗留内核

- **WHEN** 旧 secret 请求 `/version` 返回 200 且配置哈希匹配
- **THEN** 提示用户，并提供复用或终止该内核的选择

#### Scenario: 端口属于其它程序

- **WHEN** 旧 secret 请求返回 401 或 404，或连接被拒绝
- **THEN** 不干扰该进程，另选端口启动新内核

### Requirement: 退出时终止内核

系统 MUST 在退出流程中终止 mihomo 子进程，并确认进程已不存在后才完成退出。

#### Scenario: 正常退出

- **WHEN** 用户从托盘选择退出
- **THEN** 应用还原系统代理、终止内核、确认进程不存在，然后退出
