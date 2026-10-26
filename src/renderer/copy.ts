/** 渲染层所有面向用户的文案；组件不直接写字面量。 */
export const copy = {
  app: {
    name: 'Aether',
    logo: 'A'
  },
  nav: {
    labelPrimary: '主导航',
    labelSecondary: '辅助导航',
    dashboard: '仪表盘',
    nodes: '节点',
    connections: '连接',
    settings: '设置',
    logs: '日志'
  },
  dashboard: {
    title: '仪表盘',
    node: {
      label: '当前节点',
      sub: (mode: string) => `${mode} · TCP`,
      /** 失败次数还没有数据源；保留标签，值一律是未知。 */
      healthUnknown: '最近 60 分钟 —',
      healthUnknownWithDelay: (delay: string) => `最近 60 分钟 — · 最近 ${delay}`,
      noSession: '没有会话',
      session: '会话时长',
      used: '已用流量',
      mode: '工作模式'
    },
    core: {
      label: '内核状态',
      version: (version: string) => `mihomo · ${version}`,
      running: '运行中',
      stopped: '未启动',
      port: (port: string) => `端口 ${port}`,
      groups: (count: string) => `${count} 个策略组`,
      startedAt: '启动于',
      memory: '内存占用',
      guard: '进程守护'
    },
    stats: {
      down: '下载速度',
      up: '上传速度',
      connections: '活跃连接',
      connectionsFoot: '连接页在下一阶段',
      totalPrefix: '累计'
    },
    chart: {
      title: '流量历史',
      peak: '下载最高',
      average: '下载平均',
      downLegend: '下载',
      upLegend: '上传',
      idleNote: '暂无流量 · 访问任意网站试试',
      offlineNote: '启动内核后显示流量',
      label: '最近 60 秒流量曲线'
    }
  },
  status: {
    connected: '已连接',
    disconnected: '未连接',
    coreError: '内核异常'
  },
  state: {
    noConfig: {
      title: '还没有配置',
      detail: '导入一份 Clash 配置（YAML），重启内核后即可开始代理。',
      importAction: '导入配置',
      imported: '配置已导入，重启后生效',
      restartAction: '重启内核'
    },
    configError: {
      title: '配置无法使用',
      detail: '当前配置没有通过校验。导入一份合法的 Clash 配置，再重启内核。',
      importAction: '导入配置'
    },
    coreError: {
      title: '内核异常',
      detail: '代理内核没有正常运行。先尝试重启；仍然失败时请查看日志或导入新的配置。',
      restartAction: '重启内核'
    },
    inUse: {
      title: '另一个实例正在运行',
      detail: '同一时间只能有一个 Aether 实例占用配置与系统代理。关闭另一个实例后再试。'
    },
    logsAction: '查看日志',
    logsPlaceholder: '日志面板在下一阶段',
    importFailed: '导入失败，请重试',
    restartFailed: '重启失败，请重试',
    apiUnavailable: '应用接口未就绪，请重启应用'
  },
  mode: {
    label: '代理模式',
    rule: '规则',
    global: '全局',
    direct: '直连'
  },
  proxy: {
    on: '系统代理 已开启',
    off: '系统代理 已关闭'
  },
  modeSwitchFailed: '模式切换失败，请重试',
  proxyToggleFailed: '系统代理切换失败，请重试',
  version: 'Version 0.1.0'
} as const
