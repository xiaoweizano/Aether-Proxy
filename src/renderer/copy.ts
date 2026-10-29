/** 渲染层所有面向用户的文案；组件不直接写字面量。 */
export const copy = {
  app: {
    name: 'Aether',
    logo: 'A'
  },
  /**
   * 标题栏窗口按钮的无障碍名。三个按钮都是纯图标，没有可见文字，
   * 所以 `aria-label` / `title` 是它们唯一的可读名字。
   */
  window: {
    minimize: '最小化',
    maximize: '最大化',
    restore: '还原',
    close: '关闭'
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
    coreError: '内核异常',
    /** 内核意外退出、正在自动重启：是事实陈述，不承诺马上就好。 */
    reconnecting: '内核重连中'
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
    /**
     * 自动重启进行中：说明「正在自动恢复」，不给主操作。
     * 手动重启会和后台定时器抢着拉起内核，所以这里不提供。
     */
    reconnecting: {
      title: '内核重连中',
      detail: '内核意外退出，正在自动重启。恢复后状态会自行更新。'
    },
    /**
     * 重复启动提示。M1 不做单实例锁（规格 7.7）：第二个实例照常运行，只是不接管
     * 系统代理与内核。所以措辞不能写「关闭另一个实例后再试」——那暗示本实例被拦下了，
     * 而它其实就在用户眼前正常运行，只是没有代理能力。
     */
    inUse: {
      title: '另一个实例正在占用系统代理',
      detail:
        '系统代理由另一个正在运行的 Aether 实例持有。这个实例会继续运行，但不会接管系统代理，也不会再启动一个内核。'
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
    logs: {
      /**
       * 用户可能刚从仪表盘的「失败次数」点进来，不能让他看到「功能不存在」。
       * 日志确实在采集并用于失败计数，缺的只是逐条查看的界面。
       */
      note: '内核日志已开启，并用于统计拨号失败；逐条查看的日志面板将在后续计划中提供。'
    }
  },
  /**
   * 设置页（本计划唯一的新页面）。目前只有开机自启一项。
   *
   * 文案的硬约束：关闭自启时的警告必须**同屏可读**，不能做成悬浮提示或折叠说明——
   * DESIGN.md 禁止把有后果的事实藏进 hover 文本。
   */
  settings: {
    label: '设置',
    autostart: {
      label: '开机自启',
      description: '随 Windows 启动，重启后自动恢复代理，不会留下指向空端口的系统代理。',
      on: '已开启',
      off: '已关闭',
      /** 关闭时同屏显示的警告（规格原文，勿改措辞）。 */
      warning: '重启后若系统代理仍处于开启状态，需要手动启动 Aether',
      warningTitle: '注意',
      /**
       * 开发态不写注册表（账本 Ruling）：开关照常保存，但必须如实说明作用范围，
       * 不能让人以为 `npm run dev` 已经给自己装好了启动项。
       */
      devOnly: '仅打包版生效：开发模式下开关只保存设置，不会写入 Windows 启动项。',
      /** 系统实际值与保存的设置不一致：界面按系统显示，并说明这一点。 */
      systemDiffers: (system: boolean) =>
        `Windows 启动项当前为「${system ? '已开启' : '已关闭'}」，与上次保存的设置不同；开关显示的是系统实际状态。`,
      loadFailed: '无法读取开机自启状态',
      changeFailed: '开机自启切换失败，开关已恢复原状',
      /** 读屏与键盘：开关的可读名字包含当前状态，避免只播报「开关」。 */
      switchLabel: (enabled: boolean) =>
        `开机自启：${enabled ? '已开启' : '已关闭'}`
    },
    subscription: {
      label: '从订阅地址导入',
      description: '粘贴 Clash 订阅链接，一次性拉取并保存为当前配置。',
      placeholder: 'https://example.com/subscribe?token=...',
      action: '导入',
      importing: '导入中…',
      /** 内核在跑：已热重载，配置真的生效了。 */
      reloaded: '配置已导入，已热重载生效',
      /** 内核没在跑：落盘不等于生效，必须说明下一步。 */
      imported: '配置已导入，重启内核后生效',
      /** 内核在跑却拒绝了新配置：原因由主进程给出，这里只接半句。 */
      reloadFailed: '配置已导入，但内核没有接受：',
      restart: '立即重启内核',
      restarting: '重启中…',
      restartFailed: '重启内核失败',
      empty: '请先填写订阅地址',
      failed: '导入失败，请检查地址后重试'
    }
  },
  version: 'Version 0.1.0'
} as const
