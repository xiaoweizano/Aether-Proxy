/** 渲染层所有面向用户的文案；组件不直接写字面量。 */
export const copy = {
  app: {
    name: 'Aether',
    logo: 'A'
  },
  window: {
    minimize: '—',
    maximize: '▢',
    close: '✕'
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
      health: (delay: string) => `最近 60 分钟 0 次失败 · 最近 ${delay}`,
      healthRate: '100%',
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
      guard: '进程守护',
      guardOk: '正常'
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
      peak: '最高',
      average: '平均',
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
