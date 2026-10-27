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
      /**
       * 没有计数来源（采集器为 null）：没有 `windowMs` 可推导，用 DESIGN.md 写明的
       * 无数据来源句式，值保持破折号。有来源时下面两句的窗口长度一律由 `windowMs` 推导。
       */
      healthUnknown: '最近 60 分钟 —',
      /** 采集器在线、窗口内零次失败：仍然不是「健康」，值保持破折号。 */
      healthNoFailures: (window: string) => `最近 ${window} —`,
      /** 有真实失败：窗口与次数都来自计数本身。 */
      healthFailures: (window: string, count: number) => `最近 ${window} ${count} 次拨号失败`,
      /** 可点计数是「去日志看」的入口；无障碍名带上可见文字，语音控制也能命中。 */
      healthFailuresAction: (text: string) => `${text}，打开日志`,
      /** 延迟是节点属性，与失败计数无关，始终单独成句。 */
      healthDelay: (delay: string) => `· 最近 ${delay}`,
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
      /** 页脚两个数字都来自同一份快照：缓冲条数（含已结束）与保留窗口。 */
      connectionsFoot: (total: number, window: string) => `当前 ${total} 条 · 最近 ${window}`,
      /** 没有采集器（内核未运行）：连接数未知，页脚说明原因而不是编造 0。 */
      connectionsFootUnknown: '内核未运行',
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
  palette: {
    label: '命令面板',
    inputLabel: '搜索节点或命令',
    placeholder: '搜索节点或命令',
    listLabel: '命令与节点',
    actionsLabel: '动作',
    nodesLabel: '节点',
    empty: '没有匹配的命令',
    /** 六个动作；「切换模式」按设计文档展开成规则 / 全局 / 直连三项。 */
    actions: {
      proxyOn: '开启系统代理',
      proxyOff: '关闭系统代理',
      mode: (mode: string) => `切换到${mode}模式`,
      restartCore: '重启内核',
      openConfigDir: '打开配置目录',
      viewLogs: '查看日志',
      copyNode: '复制当前节点名'
    }
  },
  modeSwitchFailed: '模式切换失败，请重试',
  proxyToggleFailed: '系统代理切换失败，请重试',
  connections: {
    label: '连接列表',
    /** 采集器保留已结束连接的时长由快照的 `retainMs` 决定，文案必须由它推导。 */
    window: (window: string) => `最近 ${window}`,
    /** 没有采集器时窗口是未知，不能写死一个秒数。 */
    windowUnknown: '—',
    count: (count: number) => `${count} 条`,
    searchPlaceholder: '搜索域名或进程',
    searchLabel: '搜索域名或进程',
    activeOnly: '只看活跃',
    empty: '暂无连接',
    noMatches: '没有匹配的连接',
    ended: '已结束',
    rejected: '已拒绝',
    /** 行内详情：四组，链路不省略中间层。 */
    detail: {
      label: '连接详情',
      chain: '完整链路',
      rule: '命中规则',
      process: '进程',
      data: '数据',
      start: '开始',
      end: '结束',
      /** 展开/收起只用状态区播报给辅助技术，屏幕阅读器会读出来。 */
      expanded: (host: string) => `已展开 ${host} 详情`,
      collapsed: '已收起连接详情'
    },
    columns: {
      time: '时间',
      process: '进程',
      host: '域名',
      outbound: '出站',
      traffic: '流量',
      duration: '时长'
    }
  },
  nodes: {
    label: '策略组与节点',
    count: (count: number) => `${count} 个节点`,
    switchFailed: '节点切换失败，请重试',
    empty: '还没有可用的策略组'
  },
  /** 还没落地的页面共用一句占位说明，明确指向后续计划而不是假装功能已存在。 */
  pages: {
    planned: '后续计划',
    settings: {
      note: '设置页还没有实现，将在后续计划中补上。'
    },
    logs: {
      note: '日志页将展示内核日志。这一页在后续计划中实现。'
    }
  },
  version: 'Version 0.1.0'
} as const
