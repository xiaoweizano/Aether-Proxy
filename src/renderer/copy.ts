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
    connecting: '正在连接内核…'
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
