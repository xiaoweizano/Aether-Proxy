## ADDED Requirements

### Requirement: 配置导入

系统 SHALL 支持从本地 Clash YAML 文件或一次性 URL 导入配置。导入的原始内容 MUST 原样保存为 `profiles/<id>/upstream.yaml`，且此后永不被改写。

#### Scenario: 本地文件导入

- **WHEN** 用户选择一份合法的 Clash YAML 文件
- **THEN** 内容被保存为 `upstream.yaml`，并立即触发合并、校验与内核应用

#### Scenario: URL 一次性导入

- **WHEN** 用户填入一个可访问且返回合法 Clash YAML 的 URL
- **THEN** 内容被保存为 `upstream.yaml`；M1 不建立任何定时刷新或版本历史

#### Scenario: 导入内容非法

- **WHEN** 文件或 URL 返回的内容不是合法 YAML，或缺少 `proxies` / `proxy-groups`
- **THEN** 显示可读错误，且不覆盖已有的 `upstream.yaml`

### Requirement: 三层文件与逐键合并

系统 SHALL 按 `upstream.yaml → 注入项 → overrides.yaml` 生成 `runtime.yaml`。每个顶层键 MUST 按其既定策略合并：`rules` 用 prepend/append；`proxies`、`proxy-groups`、`proxy-providers`、`rule-providers` 按 `name` 做 map 合并；`dns`、`sniffer`、`profile` 深合并且 Aether 侧优先；`mixed-port`、`external-controller`、`secret`、`find-process-mode` 由系统注入覆盖；`tun.enable` 强制为 `false` 并清空 `redir-port` / `tproxy-port`；其余键透传。

#### Scenario: 同名节点覆盖

- **WHEN** `overrides.yaml` 中存在与上游同名的 `proxies` 条目
- **THEN** 该条目整条替换上游同名项，列表中不出现重复项

#### Scenario: 上游带 DNS 配置

- **WHEN** 上游配置包含 `dns.nameserver-policy`
- **THEN** 合并结果保留上游的 policy 条目，并叠加 Aether 侧的覆盖项

#### Scenario: 上游带 TUN 配置

- **WHEN** 上游配置包含 `tun.enable: true`
- **THEN** 生成的 `runtime.yaml` 中 `tun.enable` 为 `false`，且不申请驱动或管理员权限

### Requirement: 校验与回滚

系统 MUST 在应用配置前用同一个 `-d` home 执行 `mihomo -t` 校验。校验失败时 MUST 保留上一份可用配置，不得热重载。

#### Scenario: 校验失败

- **WHEN** 新生成的 `runtime.yaml` 未通过 `mihomo -t`
- **THEN** 不应用新配置，保留上一份可用配置，并展示内核返回的错误摘要

#### Scenario: 热重载失败

- **WHEN** `PUT /configs` 返回失败
- **THEN** 回滚到上一份配置并重新应用，界面提示本次修改未生效

### Requirement: 引用完整性检查

系统 SHALL 在合并后检查 `proxy-groups` 引用的节点、`use` 引用的 provider 是否都存在。缺失时 MUST 阻止配置应用并指出具体的组名与缺失名称。

#### Scenario: 策略组引用缺失

- **WHEN** 某个 `proxy-groups` 条目引用了合并后不存在的节点名
- **THEN** 阻止应用，错误信息包含组名与缺失的节点名

### Requirement: 配置写入安全

系统 MUST 使用临时文件加原子重命名的方式写入配置。写入失败时 MUST NOT 应用代理设置或重启内核。

#### Scenario: 磁盘写入失败

- **WHEN** 因磁盘空间或权限问题导致 `runtime.yaml` 写入失败
- **THEN** 保留上一份配置与当前代理状态，提示写入失败，不进入半应用状态
