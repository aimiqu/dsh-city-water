/**
 * dsh-city-water 演示数据单一事实源。
 *
 * 所有「城市水智管」工作台与只读工具展示的数据都来自这里；接真实水务数据时
 * 只需替换本模块（或改为从只读数据源插件取数），前端与工具契约不变。
 * 每条数据带 demo 标记：正式决策前必须核验实时数据。
 *
 * @module dsh-city-water/lib/water-data
 */

export const CITIES = ['青岛市', '济南市', '烟台市'];

const CITY_VARIANTS = {
  青岛市: {
    supply: { value: '286.4', delta: '↑ 2.8%', direction: 'up' },
    load: { value: '78.6', delta: '↓ 1.3%', direction: 'down' },
    storage: { value: '67.2', delta: '↑ 1.7%', direction: 'up' },
    alerts: { value: '3', delta: '↑ 1项', direction: 'up' },
    weather: '晴 28℃ · 东南风2级',
    demandGap: '6.8',
    forecastNote: '北部片区晚高峰存在阶段性缺口',
  },
  济南市: {
    supply: { value: '251.9', delta: '↑ 1.9%', direction: 'up' },
    load: { value: '81.3', delta: '↑ 0.8%', direction: 'up' },
    storage: { value: '71.5', delta: '↑ 2.4%', direction: 'up' },
    alerts: { value: '2', delta: '→ 持平', direction: 'up' },
    weather: '多云 26℃ · 东北风3级',
    demandGap: '5.1',
    forecastNote: '东部片区午间高峰负荷偏高',
  },
  烟台市: {
    supply: { value: '198.7', delta: '↓ 0.6%', direction: 'down' },
    load: { value: '72.4', delta: '↓ 2.2%', direction: 'down' },
    storage: { value: '75.8', delta: '↑ 3.1%', direction: 'up' },
    alerts: { value: '4', delta: '↑ 2项', direction: 'up' },
    weather: '小雨 22℃ · 东南风4级',
    demandGap: '4.2',
    forecastNote: '沿海片区短时强降雨需关注排涝',
  },
};

/** 未来 72 小时供需预测曲线（24 个点，单位 万m³）。 */
function forecastSeries(city) {
  const seed = { 青岛市: 1, 济南市: 2, 烟台市: 3 }[city] ?? 1;
  const supply = [];
  const demand = [];
  for (let i = 0; i < 24; i++) {
    const dayWave = Math.sin((i / 24) * Math.PI * 2 + seed) * 18;
    const peak = i % 24 >= 17 && i % 24 <= 20 ? 26 : 0;
    supply.push(Math.round(268 + dayWave * 0.4 + seed * 4));
    demand.push(Math.round(242 + dayWave + peak + seed * 2));
  }
  return { supply, demand };
}

export function buildWaterData(city = '青岛市') {
  const variant = CITY_VARIANTS[city] ?? CITY_VARIANTS['青岛市'];
  const forecast = forecastSeries(city);
  const demo = true;

  return {
    meta: { city, source: 'demo', generatedAt: new Date().toISOString(), version: '0.1.0' },
    metrics: [
      { key: 'supply', label: '供水总量', value: variant.supply.value, unit: '万m³', delta: variant.supply.delta, direction: variant.supply.direction, tone: 'blue', series: [40, 54, 45, 66, 52, 72, 58], demo },
      { key: 'load', label: '用水负荷', value: variant.load.value, unit: '%', delta: variant.load.delta, direction: variant.load.direction, tone: 'cyan', series: [52, 48, 61, 55, 63, 58, 60], demo },
      { key: 'storage', label: '水库蓄水率', value: variant.storage.value, unit: '%', delta: variant.storage.delta, direction: variant.storage.direction, tone: 'indigo', series: [58, 62, 57, 64, 61, 67, 64], demo },
      { key: 'alerts', label: '今日预警', value: variant.alerts.value, unit: '项', delta: variant.alerts.delta, direction: variant.alerts.direction, tone: 'orange', series: [30, 42, 36, 48, 44, 52, 46], demo },
    ],
    agent: {
      greeting: `早上好。已接入${city}水库、河道、供水管网和气象监测数据。您可以直接提出调度或风险研判任务。`,
      quickPrompts: ['研判未来72小时供水风险', '分析重点断面水质异常', '生成今日运行简报'],
      taskSteps: ['汇集多源监测数据', '调用气象情景预测', '执行供需缺口计算', '生成联动调度方案'],
    },
    weather: variant.weather,
    map: {
      labels: [
        { id: 'reservoir', text: '棘洪滩水库', detail: '蓄水变化 -1.7%' },
        { id: 'east', text: '崂山水库', detail: '蓄水变化 +0.9%' },
        { id: 'district', text: '城阳供水区', detail: '供水负荷 86.2%' },
        { id: 'south', text: '市南供水区', detail: '供水负荷 78.4%' },
      ],
      alerts: 3,
    },
    forecast: {
      supply: forecast.supply,
      demand: forecast.demand,
      note: variant.forecastNote,
      gap: variant.demandGap,
      demo,
    },
    risks: [
      { label: '水量', value: 72, level: '中', tone: 'amber' },
      { label: '水质', value: 43, level: '低', tone: 'green' },
      { label: '管网', value: 69, level: '中', tone: 'amber' },
      { label: '洪涝', value: 96, level: '高', tone: 'red' },
    ],
    suggestion: { title: 'Agent 建议', text: '当前最优先：完成北部片区高峰供水联合调度' },

    modules: {
      水情监测: {
        eyebrow: '全域感知 · 5分钟刷新', title: '水情监测一张图',
        description: '汇聚水库、河道、泵站、管网与水质站点，快速定位异常并追溯变化。',
        stats: [['在线站点', '1,286', '99.7%'], ['今日数据', '2.4亿', '条'], ['异常站点', '8', '待复核'], ['平均延迟', '1.8', '秒']],
        stations: [
          ['棘洪滩水库', '水库', '32.48m', '↘', '正常'],
          ['白沙河2号断面', '水质', '浊度 4.8NTU', '↗', '关注'],
          ['夏庄加压站', '泵站', '0.42MPa', '→', '正常'],
          ['李村河下游', '河道', '2.16m', '↗', '预警'],
          ['市南DMA-06', '管网', '漏损 7.2%', '↘', '正常'],
        ],
        equipment: [
          ['采集网关', '328/330', 'green'], ['水质传感器', '416/422', 'green'],
          ['视频设备', '205/218', 'amber'], ['雨量站', '316/316', 'green'],
        ],
      },
      供需调度: {
        eyebrow: '方案推演 · 人机协同', title: '城市供需联合调度',
        description: '基于水源、产能、需求与约束条件生成多目标调度方案，支持审批后下发。',
        stats: [['可调水源', '8', '处'], ['净水产能', '342', '万m³/d'], ['预测需求', '294', '万m³/d'], ['调度余量', '16.3', '%']],
        scenarios: [
          ['方案 A · 安全优先', '水库协同 + 管网增压', '风险最低', '推荐'],
          ['方案 B · 成本优先', '净水厂错峰 + 分区调度', '成本 -8.4%', '备选'],
          ['方案 C · 韧性优先', '预留应急水量 + 双路供水', '余量 +12%', '备选'],
        ],
        constraints: [['最低生态流量', '18.0 m³/s'], ['水库安全水位', '≤ 35.2 m'], ['管网最低压力', '≥ 0.28 MPa'], ['应急储备天数', '≥ 7 天']],
      },
      风险预警: {
        eyebrow: '分级响应 · 闭环处置', title: '风险预警与事件中心',
        description: '统一管理洪涝、供水、水质与管网风险，形成研判、派单、反馈、归档闭环。',
        stats: [['今日预警', '3', '项'], ['处置中', '2', '项'], ['平均响应', '6.2', '分钟'], ['闭环率', '96.8', '%']],
        alerts: [
          ['A-20260820-031', '橙色', '李村河下游水位快速上涨', '洪涝', '08:42'],
          ['A-20260820-030', '黄色', '城阳北部供水负荷超阈值', '供水', '08:31'],
          ['A-20260820-029', '黄色', '白沙河2号断面浊度异常', '水质', '07:56'],
        ],
        flow: [
          { step: 1, label: '监测触发', note: '系统自动', state: 'done' },
          { step: 2, label: 'Agent 研判', note: '1分24秒', state: 'done' },
          { step: 3, label: '人工签收', note: '等待处置', state: 'active' },
          { step: 4, label: '处置反馈', note: '尚未开始', state: 'todo' },
        ],
      },
      河湖管理: {
        eyebrow: '河湖长制 · 智能巡查', title: '重点河湖健康管理',
        description: '融合断面、水生态、岸线与巡查数据，持续评估河湖健康和治理成效。',
        stats: [['重点河湖', '42', '条/座'], ['达标断面', '93.4', '%'], ['今日巡查', '127', '次'], ['待办问题', '11', '项']],
        rivers: [
          ['大沽河', 91, '优', '128km'], ['白沙河', 78, '良', '36km'],
          ['李村河', 72, '良', '17km'], ['崂山水库', 94, '优', '3.2亿m³'],
        ],
        patrol: { count: 127, dots: 4 },
      },
      报告中心: {
        eyebrow: '自动编报 · 全程留痕', title: '水务报告中心',
        description: '由 Agent 汇总数据、研判依据和处置过程，快速生成简报、专报与复盘报告。',
        stats: [['本月报告', '68', '份'], ['自动生成', '84', '%'], ['待审核', '5', '份'], ['知识引用', '316', '条']],
        reports: [
          ['2026年8月20日城市供水运行日报', '日报', '待审核', '08:36'],
          ['第3号强降雨过程防御专报', '专题报告', '已发布', '08-19'],
          ['北部片区供需联合调度复盘', '复盘报告', '已归档', '08-18'],
          ['2026年7月水资源管理月报', '月报', '已发布', '08-02'],
        ],
        templates: [
          ['日', '供水运行日报'], ['专', '风险研判专报'], ['调', '调度方案简报'], ['复', '事件复盘报告'],
        ],
      },
      知识库: {
        eyebrow: '知识增强 · 可信溯源', title: '城市水务知识中枢',
        description: '统一管理法规、预案、标准、设备手册与历史案例，为 Agent 提供可追溯依据。',
        stats: [['知识文档', '12,680', '份'], ['已向量化', '98.5', '%'], ['今日检索', '1,429', '次'], ['命中率', '91.2', '%']],
        tabs: [['全部 12,680', true], ['政策法规 1,286', false], ['应急预案 326', false], ['技术标准 3,891', false], ['历史案例 6,204', false]],
        docs: [
          ['城市供水应急预案（2026修订）', '应急预案', '市水务局', '2026-07-12'],
          ['城镇供水管网运行、维护及安全技术规程', '技术标准', 'CJJ 207', '2025-11-03'],
          ['2025年“7·16”强降雨调度复盘', '历史案例', '防汛处', '2025-07-22'],
          ['饮用水水源地突发污染事件处置指南', '应急预案', '生态环境局', '2025-04-18'],
        ],
        cloud: ['防洪排涝', '水源调度', '管网漏损', '水质安全', '河湖长制', '应急处置'],
      },
    },

    system: {
      sources: [
        ['水库遥测平台', '12,846 点位', '正常'],
        ['城市供水 SCADA', '38,210 点位', '正常'],
        ['气象精细化预报', '1小时更新', '正常'],
        ['水质在线监测', '416 点位', '延迟'],
      ],
      models: { current: 'DeepSeek V4 Pro', routes: [['综合研判', 'DeepSeek V4 Pro'], ['图像巡检', 'Vision Router'], ['快速摘要', 'DeepSeek V4 Fast'], ['优化求解', 'WaterOpt Solver']] },
      plugins: [
        ['水情实时感知', '遥测与SCADA聚合'], ['多源气象预报', '网格气象与雷达外推'],
        ['供需优化求解', '多目标供水方案求解'], ['报告自动生成', '简报/专报自动编制'],
        ['移动协同', '移动端同步与审批'], ['视觉巡检', '图片与视频智能识别'],
      ],
      logs: [
        ['08:35:28', 'agent/turn.end', '供水风险研判完成', 'success'],
        ['08:35:26', 'tool/result', 'WaterOpt 求解返回 3 个方案', 'success'],
        ['08:34:51', 'approval/granted', '调度模拟获得只读授权', 'info'],
        ['08:33:02', 'data/warning', '白沙河2号站延迟 12.6 秒', 'warning'],
        ['08:31:14', 'agent/turn.start', '接收用户研判任务', 'info'],
      ],
      notifications: [
        ['橙色预警', '李村河下游水位快速上涨', '刚刚', 'red'],
        ['任务完成', '未来72小时供水风险研判已完成', '3分钟前', 'green'],
        ['数据提醒', '白沙河2号监测站存在上报延迟', '18分钟前', 'amber'],
      ],
    },

    scenariosMeta: {
      kinds: [
        ['安全优先', '水库协同 + 管网增压'],
        ['成本优先', '净水厂错峰 + 分区调度'],
        ['韧性优先', '预留应急水量 + 双路供水'],
      ],
      periods: ['未来72小时', '未来24小时', '未来7天'],
      regions: ['全市联动', '北部片区', '市南片区'],
    },
    reportMeta: {
      kinds: [
        ['市级运行简报', '综合运行态势与重点事项'],
        ['风险研判专报', '单一风险深度分析'],
        ['调度复盘报告', '调度过程、效果与改进'],
      ],
    },
  };
}

/** 供 water_overview 工具使用的紧凑态势摘要。 */
export function overviewSummary(city = '青岛市') {
  const data = buildWaterData(city);
  const [supply, load, storage, alerts] = data.metrics;
  const topRisk = data.risks.find((r) => r.level === '高') ?? data.risks[0];
  const peak = Math.max(...data.forecast.demand);
  return [
    `【${city}水资源综合态势 · 演示数据 source=demo】`,
    `- ${supply.label} ${supply.value}${supply.unit}（${supply.delta}）；${load.label} ${load.value}${load.unit}（${load.delta}）；${storage.label} ${storage.value}${storage.unit}（${storage.delta}）；${alerts.label} ${alerts.value}${alerts.unit}。`,
    `- 未来72小时供需预测：峰值需求约 ${peak} 万m³，${data.forecast.note}（预计缺口约 ${data.forecast.gap} 万m³）。`,
    `- 风险指数：水量${data.risks[0].value}（${data.risks[0].level}）、水质${data.risks[1].value}（${data.risks[1].level}）、管网${data.risks[2].value}（${data.risks[2].level}）、洪涝${data.risks[3].value}（${data.risks[3].level}）。`,
    `- 在办预警：${data.modules['风险预警'].alerts.map((a) => `${a[2]}（${a[1]}）`).join('；')}。`,
    '提示：以上为演示态势数据，正式决策前请核验实时监测。',
  ].join('\n');
}

/** 供 water_risk 工具使用的预警清单。 */
export function riskSummary(city = '青岛市', scope = 'all') {
  const data = buildWaterData(city);
  const filters = { 洪涝: '洪涝', 供水: '供水', 水质: '水质', 管网: '管网' };
  const alerts = data.modules['风险预警'].alerts.filter(
    (a) => !filters[scope] || a[3] === filters[scope],
  );
  const lines = [
    `【${city}风险预警清单 · ${scope === 'all' ? '全部' : scope} · 演示数据 source=demo】`,
  ];
  if (alerts.length === 0) lines.push('- 当前范围无在办预警。');
  for (const a of alerts) lines.push(`- ${a[0]} ${a[1]} ${a[2]}（${a[3]}风险 · ${a[4]}触发 · 置信度 92%）。`);
  lines.push('处置闭环：监测触发 → Agent 研判（已完成）→ 人工签收（等待处置）→ 处置反馈（未开始）。');
  lines.push('提示：生产操作只生成方案，必须人工审批后执行。');
  return lines.join('\n');
}

/** 供 water_report_draft 工具使用的报告草稿模板。 */
export function reportDraft(kind = '日报', city = '青岛市') {
  const data = buildWaterData(city);
  const [supply, load, storage, alerts] = data.metrics;
  const titleMap = { 日报: `${city}城市供水运行日报`, 专报: `${city}风险研判专报`, 复盘: `${city}供水调度复盘报告` };
  const kindLabel = titleMap[kind] ?? titleMap['日报'];
  return [
    `【${kindLabel} · 草稿 · 演示数据 source=demo】`,
    `一、运行摘要：${supply.label} ${supply.value}${supply.unit}（${supply.delta}），${load.label} ${load.value}${load.unit}，${storage.label} ${storage.value}${storage.unit}。`,
    `二、供需预测：未来72小时峰值需求约 ${Math.max(...data.forecast.demand)} 万m³，${data.forecast.note}。`,
    `三、风险清单：${data.modules['风险预警'].alerts.map((a) => `${a[1]}·${a[2]}`).join('；')}；${alerts.label} ${alerts.value} 项。`,
    '四、调度建议：水库协同增供 + 净水厂错峰 + 联络线小幅增压（组合方案）。',
    '五、依据引用：态势指标、供需预测曲线、风险指数与预警清单（演示数据）。',
    '状态：草稿待人工审核；发布前请核验实时数据并完成审批。',
  ].join('\n');
}
