/**
 * 城市水智管 · 水资源管理 Agent —— 工作台交互层。
 *
 * 由 city-water-agent-source/app/page.tsx 全量翻译而来（原生 JS，无框架）。
 * 与原型的两处刻意差异：
 *  1) 对话：综合研判对话区直接与「城市水资源管理 Agent」对话，走宿主
 *     /api/dsh-city-water/chat 流式通道（SSE）——配置 DeepSeek 密钥为真实模型
 *     + 水务工具调用循环；无密钥自动回退演示模式。本页不做任何本地 LLM 调用。
 *  2) 数据来源：/api/dsh-city-water/api/*（宿主插件单一事实源），
 *     页面初始化数据由宿主在 index.html 注入快照（window.__CW_DATA__），
 *     接口不可用时自动降级为快照并展示横幅。
 */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var CITIES = ['青岛市', '济南市', '烟台市'];
  var NAV_ITEMS = [
    { name: '综合研判', icon: '◔' }, { name: '水情监测', icon: '≋' },
    { name: '供需调度', icon: '☷' }, { name: '风险预警', icon: '△' },
    { name: '河湖管理', icon: '≈' }, { name: '报告中心', icon: '▣' },
    { name: '知识库', icon: '▤' },
  ];
  var DRAWER_TITLES = { data: '数据源管理', model: '模型与推理', plugin: '能力插件', log: '运行日志' };
  var DRAWER_ICONS = { data: '◉', model: '◆', plugin: '▦', log: '▤' };
  var PLUGIN_ICONS = ['≋', '☁', '⌘', '▤', '▦', '◉'];
  var COMMAND_ITEMS = ['分析未来72小时供水风险', '生成今日水务运行简报', '打开风险预警', '检查所有数据源状态', '推演北部片区供水方案'];
  var PANEL_CLOSE_EVENT = 'dsh-city-water:close';
  var TOOL_LABELS = { water_overview: '汇集态势数据', water_risk: '查询风险预警', water_report_draft: '起草水务报告' };

  var state = {
    data: window.__CW_DATA__ || null,
    hostOnline: null, // null=探测中 true=在线 false=离线
    activeNav: '综合研判',
    drawer: null,
    modal: null,
    notificationsOpen: false,
    prompt: '',
    toast: '',
    toastTimer: null,
    selectedNode: '城阳供水区',
    acknowledged: [],
    pending: null, // { running, text, steps:[{tool,phase}], mode }
    messages: [],
    enabledPlugins: {},
    scenario: '安全优先',
    reportType: '市级运行简报',
    schedulePeriod: '未来72小时',
    scheduleRegion: '全市联动',
    supplyCap: 5,
    pressureCap: 5,
    reportCharts: true, reportCites: true, reportSummary: true,
  };

  function inIframe() {
    try { return window.self !== window.top || window.parent !== window.self; } catch (e) { return true; }
  }
  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function nowTime() {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  }
  function todayLabel() {
    var d = new Date();
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }
  function currentCity() {
    var meta = state.data && state.data.meta;
    return meta && CITIES.indexOf(meta.city) !== -1 ? meta.city : '青岛市';
  }

  // ---------- toast ----------
  function notify(message) {
    state.toast = message;
    renderToast();
    if (state.toastTimer !== null) window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(function () {
      state.toast = '';
      renderToast();
    }, 2600);
  }

  // ---------- 数据加载 ----------
  function loadData(city) {
    return fetch('/api/dsh-city-water/api/overview?city=' + encodeURIComponent(city))
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (payload) {
        if (payload && payload.data) {
          state.data = payload.data;
          state.hostOnline = true;
        }
      })
      .catch(function () {
        state.hostOnline = false;
      })
      .then(renderAll);
  }

  function probeHost() {
    fetch('/api/dsh-city-water/api/info', { cache: 'no-store' })
      .then(function (res) {
        state.hostOnline = res.ok;
        renderHostPill();
      })
      .catch(function () {
        state.hostOnline = false;
        renderHostPill();
      });
  }

  function cycleCity() {
    var list = CITIES;
    var next = list[(list.indexOf(currentCity()) + 1) % list.length];
    notify('正在加载' + next + '演示态势…');
    void loadData(next);
  }

  // ---------- 面板内对话（宿主 /chat SSE 流式通道）----------
  function backToChat() {
    if (inIframe()) {
      try {
        window.parent.postMessage({ type: PANEL_CLOSE_EVENT }, window.location.origin);
        return;
      } catch (e) { /* fall through */ }
    }
    notify('当前为独立标签页，直接在下方对话区使用 Agent 即可');
  }

  function historyPayload() {
    return state.messages
      .filter(function (m) { return (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string'; })
      .slice(-12)
      .map(function (m) { return { role: m.role, content: m.text }; });
  }

  function isBusy() { return !!(state.pending && state.pending.running); }

  function finishChat(failed) {
    var p = state.pending;
    if (p === null) return;
    state.messages.push({
      role: 'assistant',
      text: p.text || (failed ? '（对话失败：未收到内容）' : '（无内容）'),
      time: nowTime(),
      mode: failed ? 'error' : (p.mode || 'demo'),
    });
    state.pending = null;
    renderChatArea();
  }

  function submitPrompt(text) {
    var cleaned = (text === undefined ? state.prompt : text).trim();
    if (!cleaned || isBusy()) return;
    state.messages.push({ role: 'user', text: cleaned, time: nowTime() });
    state.prompt = '';
    state.pending = { running: true, text: '', steps: [], mode: null };
    renderChatArea();
    void streamChat(cleaned);
  }

  async function streamChat(query) {
    var finished = false;
    var markDone = function (failed) {
      if (finished) return;
      finished = true;
      finishChat(failed);
    };
    try {
      var res = await fetch('/api/dsh-city-water/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: query, city: currentCity(), history: historyPayload() }),
      });
      if (!res.ok || !res.body) throw new Error('HTTP ' + (res.status || 'error'));
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var handleFrame = function (frame) {
        var event = 'delta';
        var dataLines = [];
        var lines = frame.split('\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.indexOf('event:') === 0) event = line.slice(6).trim();
          else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) return;
        var payload;
        try { payload = JSON.parse(dataLines.join('\n')); } catch (e) { return; }
        if (event === 'delta' && typeof payload.text === 'string') {
          state.pending.text += payload.text;
          var el = $('#assistant-stream');
          if (el !== null) el.textContent = state.pending.text;
          else renderChatArea();
        } else if (event === 'status' && payload.step === 'tool' && typeof payload.tool === 'string') {
          if (payload.phase === 'running') {
            state.pending.steps.push({ tool: payload.tool, phase: 'running' });
          } else if (payload.phase === 'done') {
            for (var j = state.pending.steps.length - 1; j >= 0; j--) {
              if (state.pending.steps[j].tool === payload.tool) { state.pending.steps[j].phase = 'done'; break; }
            }
          }
          renderChatArea();
        } else if (event === 'done') {
          state.pending.mode = payload.mode || 'demo';
          markDone(false);
        } else if (event === 'error') {
          state.pending.text += (state.pending.text ? '\n\n' : '') + '【对话失败】' + (payload.message || '未知错误');
          markDone(true);
        }
      };
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        for (var f = 0; f < frames.length; f++) handleFrame(frames[f]);
      }
      var tail = buffer.trim();
      if (tail !== '') handleFrame(tail);
      markDone(false);
    } catch (error) {
      if (state.pending !== null) {
        state.pending.text += (state.pending.text ? '\n\n' : '') + '【对话失败】' + (error && error.message ? error.message : String(error)) + '（请确认宿主插件在线后重试）';
      }
      markDone(true);
    }
  }

  // ---------- 渲染入口 ----------
  function renderAll() {
    renderNav();
    renderTopbar();
    renderPage();
    renderRail();
    renderOverlays();
  }
  function renderNav() {
    var nav = $('#main-nav');
    nav.innerHTML = NAV_ITEMS.map(function (item) {
      var active = state.activeNav === item.name ? ' active' : '';
      return '<button class="nav-item' + active + '" data-action="navigate" data-nav="' + esc(item.name) + '"' + (state.activeNav === item.name ? ' aria-current="page"' : '') + '><span class="nav-glyph" aria-hidden="true">' + item.icon + '</span><span>' + esc(item.name) + '</span></button>';
    }).join('');
  }
  function renderTopbar() {
    var crumb = $('#crumb');
    if (crumb !== null) crumb.textContent = state.activeNav;
    var city = $('#city-name');
    if (city !== null) city.textContent = currentCity();
    var date = $('#date-label');
    if (date !== null) date.textContent = todayLabel();
    var count = $('#notice-count');
    if (count !== null && state.data) count.textContent = String(state.data.system.notifications.length);
    renderHostPill();
  }
  function renderHostPill() {
    var pill = $('#host-status');
    if (pill === null) return;
    if (state.hostOnline === true) {
      pill.className = 'host-pill';
      pill.innerHTML = '<i></i><span>Agent 在线 · 宿主已连接</span>';
    } else if (state.hostOnline === false) {
      pill.className = 'host-pill offline';
      pill.innerHTML = '<i></i><span>宿主未连接 · 演示快照</span>';
    } else {
      pill.className = 'host-pill offline';
      pill.innerHTML = '<i></i><span>连接中…</span>';
    }
  }
  function renderRail() {
    var rail = $('.utility-rail');
    if (rail === null) return;
    var buttons = $$('button', rail);
    buttons.forEach(function (btn) {
      var key = btn.getAttribute('data-drawer');
      if (state.drawer === key) btn.classList.add('active');
      else btn.classList.remove('active');
    });
  }

  function renderPage() {
    var area = $('#page-area');
    if (area === null) return;
    var html = state.activeNav === '综合研判' ? overviewHtml() : modulePageHtml(state.activeNav);
    area.innerHTML = html;
    if (state.activeNav === '综合研判') {
      bindComposer();
      if (isBusy()) renderChatArea();
    }
  }

  // ================= 综合研判 =================
  function overviewHtml() {
    var d = state.data;
    if (d === null) return '<div class="dashboard"><section class="panel"><div class="panel-title"><strong>正在加载…</strong></div></section></div>';
    var banner = state.hostOnline === false
      ? '<div class="host-banner"><i>!</i><div>数据服务未连接，当前展示宿主注入的演示快照（source=demo）。请在 DSH 中确认插件已加载，或稍后刷新。</div></div>'
      : '';
    return '<div class="dashboard">' + banner
      + '<section class="metrics-grid" aria-label="关键水务指标">' + d.metrics.map(metricCardHtml).join('') + '</section>'
      + '<section class="main-grid">' + agentPanelHtml(d) + '<div class="insight-column">' + topologyPanelHtml(d) + '<div class="analytics-grid">' + riskCardHtml(d) + forecastCardHtml(d) + '</div></div></section>'
      + actionBarHtml(d) + '</div>';
  }

  function metricCardHtml(m) {
    var bars = (m.series || []).map(function (h) { return '<i style="height:' + Number(h) + '%"></i>'; }).join('');
    return '<article class="metric-card"><div class="metric-icon ' + m.tone + '">' + ({ supply: '◒', load: '◴', storage: '≋', alerts: '!' }[m.key] || '◒') + '</div>'
      + '<div class="metric-copy"><span>' + esc(m.label) + '</span><strong>' + esc(m.value) + '<small>' + esc(m.unit) + '</small></strong>'
      + '<em class="' + (String(m.delta).indexOf('↓') !== -1 ? 'down' : 'up') + '">较昨日 ' + esc(m.delta) + '</em></div>'
      + '<div class="mini-chart ' + m.tone + '">' + bars + '</div></article>';
  }

  function agentPanelHtml(d) {
    var quick = (d.agent.quickPrompts || []).map(function (item) {
      return '<button data-action="quick-prompt" data-text="' + esc(item) + '"' + (isBusy() ? ' disabled' : '') + '>' + esc(item) + '</button>';
    }).join('');
    return '<article class="panel agent-panel">'
      + '<div class="panel-title"><span class="round-logo">≈</span><strong>城市水资源管理 Agent</strong>'
      + '<span class="live-pill"><i></i>实时协同 · 水务 Agent</span>'
      + '<button class="icon-btn" data-action="notify" data-msg="对话由宿主 /chat 通道承载：配置 DeepSeek 密钥为真实模型 + 水务工具，无密钥自动回退演示模式">⋯</button></div>'
      + '<div class="chat-stream" id="chat-stream">' + chatHtml() + '</div>'
      + '<div class="quick-prompts">' + quick + '</div>'
      + '<form class="composer" id="composer">'
      + '<textarea aria-label="向 Agent 输入任务" id="composer-input" placeholder="输入研判、调度或报告生成任务…"></textarea>'
      + '<div><span><button type="button" aria-label="添加附件" data-action="notify" data-msg="附件能力将在后续版本接入（视觉巡检插件）">♧</button>'
      + '<button type="button" aria-label="添加数据集" data-action="notify" data-msg="数据集由数据源插件提供，请先打开数据源抽屉">⊞</button>'
      + '<button type="button" aria-label="提及专家" data-action="notify" data-msg="专家协作能力将在后续版本接入">@</button></span>'
      + '<button class="send-btn" type="submit" id="send-btn" disabled>➤<i>⌄</i></button></div></form></article>';
  }

  function modeBadgeHtml(mode) {
    if (mode === 'live') return '<span class="mode-badge live">DeepSeek 实时</span>';
    if (mode === 'error') return '<span class="mode-badge error">出错</span>';
    return '<span class="mode-badge demo">演示模式</span>';
  }

  function chatHtml() {
    var lastAssistant = -1;
    state.messages.forEach(function (m, i) { if (m.role === 'assistant') lastAssistant = i; });
    var html = state.messages.map(function (m, i) {
      if (m.role === 'assistant') {
        var cls = i === lastAssistant && i > 1 ? 'conclusion bubble' : 'bubble';
        return '<div class="bot-row"><span class="bot-avatar">✦</span><div><div class="' + cls + '">' + esc(m.text) + '</div><time>' + esc(m.time) + '</time>'
          + (m.mode ? modeBadgeHtml(m.mode) : '') + '</div></div>';
      }
      return '<div class="user-row"><time>' + esc(m.time) + '</time><div class="bubble user">' + esc(m.text) + '</div><span class="user-avatar">人</span></div>';
    }).join('');
    if (state.pending && state.pending.running) {
      var steps = state.pending.steps;
      if (steps.length > 0) {
        var doneCount = steps.filter(function (s) { return s.phase === 'done'; }).length;
        var progress = Math.round((doneCount / steps.length) * 100);
        var lis = steps.map(function (step) {
          var cls = step.phase === 'done' ? 'done' : 'running';
          return '<li class="' + cls + '">' + esc(TOOL_LABELS[step.tool] || step.tool) + '<time>' + (step.phase === 'done' ? '已完成' : '进行中') + '</time></li>';
        }).join('');
        html += '<div class="task-box"><div><strong><span class="spinner"></span>研判任务执行中</strong><span>' + progress + '%</span></div>'
          + '<div class="task-progress"><i style="width:' + progress + '%"></i></div><ol>' + lis + '</ol></div>';
      } else {
        html += '<div class="task-box"><div><strong><span class="spinner"></span>模型研判中…</strong></div>'
          + '<div class="task-progress"><i class="indeterminate"></i></div></div>';
      }
      html += '<div class="bot-row"><span class="bot-avatar">✦</span><div><div class="bubble streaming" id="assistant-stream"></div></div></div>';
    }
    return html;
  }

  function bindComposer() {
    var form = $('#composer');
    var input = $('#composer-input');
    var send = $('#send-btn');
    if (form === null || input === null || send === null) return;
    input.value = state.prompt;
    send.disabled = !state.prompt.trim() || isBusy();
    input.addEventListener('input', function () {
      state.prompt = input.value;
      send.disabled = !state.prompt.trim() || isBusy();
    });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submitPrompt();
      }
    });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      submitPrompt();
    });
  }

  function renderChatArea() {
    var stream = $('#chat-stream');
    if (stream === null) return;
    stream.innerHTML = chatHtml();
    var live = $('#assistant-stream');
    if (live !== null && state.pending !== null) live.textContent = state.pending.text;
    stream.scrollTop = stream.scrollHeight;
    bindComposer();
  }

  // ============ 实时态势 · 城市供水系统拓扑示意图（纯 SVG 前端生成） ============
  // 布局：左→右 = 水源端（水库）→ 输配端（净水厂 / 输水干线）→ 用水端（供水区）。
  // 坐标为手工定义的业务示意图，非真实管网；无位图、无外部地图服务、无道路纹理。
  var TOPO_NODES = [
    { id: 'jihongtan', name: '棘洪滩水库', type: '水库', status: 'normal', metric: '蓄水率 72.4%', x: 104, y: 140, icon: 'drop' },
    { id: 'laoshan', name: '崂山水库', type: '水库', status: 'normal', metric: '蓄水率 61.8%', x: 104, y: 350, icon: 'drop' },
    { id: 'plant1', name: '第一净水厂', type: '净水厂', status: 'normal', metric: '产能 54万m³/d', x: 380, y: 140, icon: 'factory' },
    { id: 'plant2', name: '第二净水厂', type: '净水厂', status: 'normal', metric: '产能 48万m³/d', x: 380, y: 350, icon: 'factory' },
    { id: 'trunk', name: '主要输水干线', type: '输水干线', status: 'normal', metric: '输送量 96万m³/d', x: 380, y: 245, icon: 'pipe' },
    { id: 'shinan', name: '市南供水区', type: '供水区', status: 'normal', metric: '负荷 78.4%', x: 656, y: 140, icon: 'zone' },
    { id: 'chengyang', name: '城阳供水区', type: '供水区', status: 'attention', metric: '负荷 86.2%', x: 656, y: 245, icon: 'zone' },
    { id: 'north', name: '北部供水区', type: '供水区', status: 'danger', metric: '负荷 91.6%', x: 656, y: 350, icon: 'zone' },
  ];
  // 连线：仅表达业务流向（水库→净水厂→主干线→供水区），不交叉。
  var TOPO_LINKS = [
    [134, 140, 350, 140], [134, 350, 350, 350],
    [380, 170, 380, 215], [380, 380, 380, 275],
    [410, 245, 626, 140], [410, 245, 626, 245], [410, 245, 626, 350],
  ];
  var TOPO_STATUS_TEXT = { normal: '正常', attention: '关注', danger: '预警' };
  var TOPO_ICONS = {
    drop: '<path d="M0,-13C7.5,-5.5 12,0.5 12,6.5A12,12 0 1 1 -12,6.5C-12,0.5 -7.5,-5.5 0,-13Z"/>',
    factory: '<rect x="-13" y="-3" width="26" height="14" rx="1.5"/><rect x="-9" y="3" width="5" height="4" rx="1"/><rect x="4" y="3" width="5" height="4" rx="1"/><rect x="-13" y="-14" width="3.5" height="11" rx="1"/>',
    pipe: '<rect x="-15" y="-2.5" width="30" height="5" rx="2.5"/><rect x="-15" y="-5" width="3" height="10" rx="1"/><rect x="12" y="-5" width="3" height="10" rx="1"/>',
    zone: '<path d="M-14,0L0,-12L14,0Z"/><rect x="-9" y="0" width="18" height="12" rx="1.5"/>',
  };

  function topologyPanelHtml(d) {
    var status = function (node) { return node.status || 'normal'; };
    var links = TOPO_LINKS.map(function (l) {
      return '<path class="topo-link" d="M' + l[0] + ',' + l[1] + 'L' + l[2] + ',' + l[3] + '"/>';
    }).join('');
    var nodes = TOPO_NODES.map(function (n) {
      var st = status(n);
      var cls = 'topo-node st-' + st + (state.selectedNode === n.name ? ' selected' : '');
      var dot = st === 'normal' ? '' : '<circle class="topo-node-dot st-' + st + '" cx="' + (n.x + 22) + '" cy="' + (n.y - 21) + '" r="8"/>';
      var ring = state.selectedNode === n.name ? '<circle class="topo-node-ring" cx="' + n.x + '" cy="' + n.y + '" r="37"/>' : '';
      return '<g class="' + cls + '" data-action="topo-node" data-node="' + esc(n.name) + '" role="button" tabindex="0" aria-label="' + esc(n.name + ' ' + n.type + ' ' + TOPO_STATUS_TEXT[st]) + '">'
        + ring
        + '<circle class="topo-node-circle" cx="' + n.x + '" cy="' + n.y + '" r="30"/>'
        + '<g class="topo-node-icon" transform="translate(' + n.x + ',' + n.y + ')">' + TOPO_ICONS[n.icon] + '</g>'
        + '<text class="topo-node-name" x="' + n.x + '" y="' + (n.y + 46) + '">' + esc(n.name) + '</text>'
        + '<text class="topo-node-sub" x="' + n.x + '" y="' + (n.y + 64) + '">' + esc(TOPO_STATUS_TEXT[st] + ' · ' + n.metric) + '</text>'
        + dot
        + '</g>';
    }).join('');
    var sel = TOPO_NODES.filter(function (n) { return n.name === state.selectedNode; })[0] || TOPO_NODES[0];
    var detail = '<aside class="topo-detail" aria-label="节点详情">'
      + '<h3><i class="td-dot st-' + status(sel) + '"></i>' + esc(sel.name) + '</h3>'
      + '<div class="td-row"><span>节点类型</span><b>' + esc(sel.type) + '</b></div>'
      + '<div class="td-row"><span>当前状态</span><b class="td-status st-' + status(sel) + '">' + esc(TOPO_STATUS_TEXT[status(sel)]) + '</b></div>'
      + '<div class="td-row"><span>关键指标</span><b>' + esc(sel.metric) + '</b></div>'
      + '<div class="td-row"><span>数据更新时间</span><b>' + esc(topoUpdateTime()) + '</b></div>'
      + '<button class="topo-analyze-btn" data-action="topo-analyze" data-node="' + esc(sel.name) + '">让Agent分析此节点</button>'
      + '</aside>';
    var svgLegend = '<g class="topo-legend-svg" aria-hidden="true">'
      + '<circle class="tl-dot tl-normal" cx="26" cy="443" r="5"/><text x="37" y="447">正常</text>'
      + '<circle class="tl-dot tl-attention" cx="84" cy="443" r="5"/><text x="95" y="447">关注</text>'
      + '<circle class="tl-dot tl-danger" cx="141" cy="443" r="5"/><text x="152" y="447">预警</text>'
      + '<text class="tl-hint" x="208" y="447">拓扑示意 · 非真实管网</text></g>';
    return '<article class="panel map-panel">'
      + '<div class="panel-title"><strong>实时态势</strong>'
      + '<span class="weather"><i></i>' + esc(d.weather || '') + '</span>'
      + '<span class="topo-demo-badge">演示数据 · 拓扑示意</span>'
      + '<button class="text-btn" data-action="refresh">刷新</button></div>'
      + '<div class="topo-stage"><div class="topo-canvas-wrap">'
      + '<div class="topo-canvas"><svg class="topo-svg" viewBox="0 0 760 470" role="img" aria-label="城市供水系统拓扑示意图（演示）">'
      + '<text class="topo-col" x="104" y="36">水源端</text><text class="topo-col" x="380" y="36">输配端</text><text class="topo-col" x="656" y="36">用水端</text>'
      + links + nodes + svgLegend
      + '</svg></div>'
      + detail
      + '</div></div></article>';
  }

  function topoUpdateTime() {
    var meta = state.data && state.data.meta;
    if (!meta || !meta.generatedAt) return '—';
    try {
      var d = new Date(meta.generatedAt);
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    } catch (e) { return '—'; }
  }

  // ============ 未来72小时供需预测：真实数据连续曲线（SVG） ============
  // 缩放：数据 min/max 上下留 6%~12% 边距，映射到 300×150 视图（上 9 / 下 9 像素留白）。
  function forecastScale(supply, demand) {
    var all = supply.concat(demand);
    var mn, mx;
    if (all.length === 0) { mn = 0; mx = 1; }
    else {
      mn = Math.min.apply(null, all);
      mx = Math.max.apply(null, all);
    }
    var pad = Math.max(6, Math.round((mx - mn) * 0.12));
    return { min: mn - pad, max: mx + pad, width: 300, height: 150, top: 9, bottom: 9 };
  }
  function num(x) { return Math.round(x * 10) / 10; }
  function forecastY(sc, v) {
    return sc.height - sc.bottom - ((v - sc.min) / (sc.max - sc.min)) * (sc.height - sc.top - sc.bottom);
  }
  // Catmull-Rom → 三次贝塞尔：24 点平滑为连续曲线。
  function forecastPath(values, sc) {
    var n = values.length;
    if (n === 0) return '';
    var pts = values.map(function (v, i) {
      return [i * (sc.width / (n - 1)), forecastY(sc, v)];
    });
    if (n < 3) return 'M' + num(pts[0][0]) + ',' + num(pts[0][1]) + 'L' + num(pts[n - 1][0]) + ',' + num(pts[n - 1][1]);
    var d = 'M' + num(pts[0][0]) + ',' + num(pts[0][1]);
    for (var i = 0; i < n - 1; i++) {
      var p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
      var c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      var c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += 'C' + num(c1x) + ',' + num(c1y) + ' ' + num(c2x) + ',' + num(c2y) + ' ' + num(p2[0]) + ',' + num(p2[1]);
    }
    return d;
  }
  // 供给曲线下方浅色面积填充。
  function forecastArea(values, sc) {
    var base = sc.height - sc.bottom;
    return forecastPath(values, sc) + 'L' + sc.width + ',' + base + 'L0,' + base + 'Z';
  }
  // y 轴刻度：按数据跨度取 5 个「整步长」标签（与图形等分位置对齐，去重）。
  function forecastTicks(sc) {
    var span = sc.max - sc.min;
    var raw = span / 4;
    var steps = [5, 10, 20, 25, 40, 50, 100, 200, 500];
    var step = steps.find(function (s) { return s >= raw; }) || 200;
    var ticks = [];
    for (var k = 0; k <= 4; k++) {
      var v = sc.min + span * k / 4;
      var nice = Math.round(v / step) * step;
      if (nice < sc.min || nice > sc.max || ticks.indexOf(nice) !== -1) nice = Math.round(v);
      ticks.push(nice);
    }
    return ticks;
  }

  function forecastCardHtml(d) {
    var f = d.forecast || {};
    var supply = f.supply || [];
    var demand = f.demand || [];
    var peak = Math.max.apply(null, demand.length ? demand : [0]);
    var sc = forecastScale(supply, demand);
    var yLabels = forecastTicks(sc).map(function (v) { return '<span>' + v + '</span>'; }).join('');
    var xLabels = ['08-20 00时', '08-21 00时', '08-22 00时', '08-23 00时']
      .map(function (t) { return '<span>' + t + '</span>'; }).join('');
    var supplyPath = supply.length > 1 ? forecastPath(supply, sc) : '';
    var demandPath = demand.length > 1 ? forecastPath(demand, sc) : '';
    var areaPath = supply.length > 1 ? forecastArea(supply, sc) : '';
    return '<article class="panel forecast-card"><div class="card-heading"><div><strong>未来72小时供需预测</strong>'
      + '<span>峰值需求约 ' + peak + ' 万m³ · ' + esc(f.note || '') + '</span></div>'
      + '<button data-action="notify" data-msg="已切换至小时级数据">小时⌄</button></div>'
      + '<div class="chart-legend"><span><i class="supply"></i>供水量</span><span><i class="demand"></i>用水量</span></div>'
      + '<div class="line-chart"><div class="y-labels">' + yLabels + '</div>'
      + '<div class="plot"><div class="plot-area"><svg class="forecast-svg" viewBox="0 0 300 150" preserveAspectRatio="none" aria-label="未来72小时供需预测曲线">'
      + '<path class="supply-area" d="' + areaPath + '"/>'
      + '<path class="supply-line" d="' + supplyPath + '"/>'
      + '<path class="demand-line" d="' + demandPath + '"/></svg></div>'
      + '<div class="x-labels">' + xLabels + '</div></div></div></article>';
  }

  function riskCardHtml(d) {
    var bars = (d.risks || []).map(function (r) {
      return '<div class="risk-row"><span>' + esc(r.label) + '</span><div><i class="' + r.tone + '" style="width:' + Number(r.value) + '%"></i></div><b>' + esc(r.level) + '</b></div>';
    }).join('');
    return '<article class="panel risk-card"><div class="card-heading"><div><strong>风险分布</strong><span>综合指数</span></div>'
      + '<button aria-label="查看说明" data-action="notify" data-msg="指数由洪涝/供水/水质/管网四类模型输出综合">ⓘ</button></div>'
      + '<div class="risk-bars">' + bars + '</div><div class="risk-axis"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div></article>';
  }

  function actionBarHtml(d) {
    var s = d.suggestion || { title: 'Agent 建议', text: '' };
    return '<section class="action-bar"><div><b>' + esc(s.title) + '</b><span>' + esc(s.text) + '</span></div>'
      + '<button class="primary-action" data-action="open-schedule">⌘ 生成调度方案</button>'
      + '<button class="secondary-action" data-action="open-report">▣ 生成市级简报</button>'
      + '<button class="link-action" data-action="notify" data-msg="研判依据与工具调用记录见对话上方任务步与日志抽屉">查看研判依据 ›</button></section>';
  }

  // ================= 模块页 =================
  function modulePageHtml(name) {
    var d = state.data;
    if (d === null) return '<div class="module-page"></div>';
    var m = d.modules[name];
    if (m === undefined) return '<div class="module-page"></div>';
    var stats = m.stats.map(function (row) {
      return '<article><span>' + esc(row[0]) + '</span><strong>' + esc(row[1]) + '<small>' + esc(row[2]) + '</small></strong><i></i></article>';
    }).join('');
    var primaryAction = name === '报告中心' ? 'open-report' : name === '供需调度' ? 'open-schedule' : 'refresh';
    var primaryLabel = name === '报告中心' ? '＋ 新建报告' : name === '供需调度' ? '⌘ 新建方案' : '↻ 刷新数据';
    return '<div class="module-page"><section class="module-hero"><div><span>' + esc(m.eyebrow) + '</span><h1>' + esc(m.title) + '</h1><p>' + esc(m.description) + '</p></div>'
      + '<div><button class="secondary-action" data-action="ask-agent" data-query="请对' + esc(name) + '当前情况进行综合研判">✦ 询问 Agent</button>'
      + '<button class="primary-action" data-action="' + primaryAction + '">' + primaryLabel + '</button></div></section>'
      + '<section class="module-stats">' + stats + '</section>'
      + moduleBodyHtml(name, m) + '</div>';
  }

  function moduleBodyHtml(name, m) {
    if (name === '水情监测') {
      var rows = m.stations.map(function (row) {
        return '<div class="table-row">' + row.map(function (cell, i) {
          return '<span class="' + (i === 4 ? 'status ' + cell : '') + '">' + esc(cell) + '</span>';
        }).join('') + '</div>';
      }).join('');
      var equip = m.equipment.map(function (e) { return '<li><i class="' + e[2] + '"></i>' + esc(e[0]) + ' <b>' + esc(e[1]) + '</b></li>'; }).join('');
      return '<div class="module-grid"><section class="panel wide-card"><div class="panel-title"><strong>重点站点实时数据</strong>'
        + '<button class="text-btn" data-action="notify" data-msg="监测列表已导出">导出</button></div>'
        + '<div class="data-table"><div class="table-head"><span>监测站点</span><span>类型</span><span>当前值</span><span>趋势</span><span>状态</span></div>' + rows + '</div></section>'
        + '<aside class="panel side-card"><div class="panel-title"><strong>设备健康</strong></div><div class="donut"><strong>96.8%</strong><span>综合在线率</span></div><ul class="compact-list">' + equip + '</ul></aside></div>';
    }
    if (name === '供需调度') {
      var scenarios = m.scenarios.map(function (item, index) {
        return '<article class="' + (index === 0 ? 'recommended' : '') + '"><div><span>' + (index + 1) + '</span><div><strong>' + esc(item[0]) + '</strong><p>' + esc(item[1]) + '</p></div></div><b>' + esc(item[2]) + '</b><em>' + esc(item[3]) + '</em><button data-action="open-schedule">推演</button></article>';
      }).join('');
      var constraints = m.constraints.map(function (c) { return '<div>' + esc(c[0]) + '<b>' + esc(c[1]) + '</b></div>'; }).join('');
      return '<div class="module-grid"><section class="panel wide-card"><div class="panel-title"><strong>推荐调度场景</strong>'
        + '<button class="text-btn" data-action="open-schedule">调整约束</button></div>'
        + '<div class="scenario-list">' + scenarios + '</div></section>'
        + '<aside class="panel side-card"><div class="panel-title"><strong>调度约束</strong></div><div class="constraint-list">' + constraints + '</div>'
        + '<button class="primary-action block" data-action="open-schedule">进入方案推演</button></aside></div>';
    }
    if (name === '风险预警') {
      var alerts = m.alerts.map(function (item) {
        var acked = state.acknowledged.indexOf(item[0]) !== -1;
        return '<article class="' + (acked ? 'acked' : '') + '"><i class="' + esc(item[1]) + '"></i><div><span>' + esc(item[0]) + ' · ' + esc(item[4]) + '</span><strong>' + esc(item[2]) + '</strong><small>' + esc(item[3]) + '风险 · 置信度 92%</small></div>'
          + '<button data-action="ack" data-id="' + esc(item[0]) + '">' + (acked ? '已签收' : '签收处置') + '</button></article>';
      }).join('');
      var flow = m.flow.map(function (f) {
        return '<div class="' + f.state + '"><i>' + f.step + '</i><span>' + esc(f.label) + '<small>' + esc(f.note) + '</small></span></div>';
      }).join('');
      return '<div class="module-grid"><section class="panel wide-card"><div class="panel-title"><strong>实时预警清单</strong><span class="filter-chip">全部级别⌄</span></div>'
        + '<div class="alert-list">' + alerts + '</div></section>'
        + '<aside class="panel side-card"><div class="panel-title"><strong>响应闭环</strong></div><div class="response-flow">' + flow + '</div>'
        + '<button class="secondary-action block" data-action="notify" data-msg="值班通讯录已打开">打开值班通讯录</button></aside></div>';
    }
    if (name === '河湖管理') {
      var rivers = m.rivers.map(function (item) {
        return '<article><div class="score-ring" style="--score:' + (Number(item[1]) * 3.6) + 'deg"><strong>' + esc(item[1]) + '</strong></div>'
          + '<div><b>' + esc(item[0]) + '</b><span>健康等级：' + esc(item[2]) + '</span><small>管理范围 ' + esc(item[3]) + '</small></div>'
          + '<button data-action="notify" data-msg="' + esc(item[0]) + '档案已打开">查看档案</button></article>';
      }).join('');
      var dots = [1, 2, 3, 4].map(function (n) { return '<i class="dot d' + n + '"></i>'; }).join('');
      return '<div class="module-grid"><section class="panel wide-card"><div class="panel-title"><strong>重点河湖健康指数</strong><span class="filter-chip">2026年8月⌄</span></div>'
        + '<div class="river-cards">' + rivers + '</div></section>'
        + '<aside class="panel side-card"><div class="panel-title"><strong>今日巡查</strong></div><div class="patrol-stat"><strong>' + esc(m.patrol.count) + '</strong><span>已完成巡查</span></div>'
        + '<div class="patrol-map">' + dots + '</div>'
        + '<button class="primary-action block" data-action="notify" data-msg="巡查任务已创建">＋ 发起智能巡查</button></aside></div>';
    }
    if (name === '报告中心') {
      var reports = m.reports.map(function (item, index) {
        return '<article><span class="doc-icon">▤</span><div><strong>' + esc(item[0]) + '</strong><p>' + esc(item[1]) + ' · Agent 引用 ' + (24 - index * 3) + ' 条依据</p></div>'
          + '<em class="' + esc(item[2]) + '">' + esc(item[2]) + '</em><time>' + esc(item[3]) + '</time>'
          + '<button data-action="notify" data-msg="已打开：' + esc(item[0]) + '">查看</button></article>';
      }).join('');
      var templates = m.templates.map(function (t) {
        return '<button data-action="open-report"><span>' + esc(t[0]) + '</span><b>' + esc(t[1]) + '</b><i>›</i></button>';
      }).join('');
      return '<div class="module-grid"><section class="panel wide-card"><div class="panel-title"><strong>最近报告</strong>'
        + '<button class="text-btn" data-action="open-report">新建报告</button></div>'
        + '<div class="report-list">' + reports + '</div></section>'
        + '<aside class="panel side-card"><div class="panel-title"><strong>快捷模板</strong></div><div class="template-list">' + templates + '</div></aside></div>';
    }
    // 知识库
    var tabs = m.tabs.map(function (t) {
      return '<button class="' + (t[1] ? 'active' : '') + '" data-action="notify" data-msg="已切换知识分类：' + esc(t[0]) + '">' + esc(t[0]) + '</button>';
    }).join('');
    var docs = m.docs.map(function (item) {
      return '<article><span>▤</span><div><strong>' + esc(item[0]) + '</strong><p>' + esc(item[1]) + ' · ' + esc(item[2]) + ' · ' + esc(item[3]) + '</p></div><b>已向量化</b>'
        + '<button data-action="notify" data-msg="已引用：' + esc(item[0]) + '">引用</button></article>';
    }).join('');
    var cloud = m.cloud.map(function (c) { return '<span>' + esc(c) + '</span>'; }).join('');
    return '<div class="module-grid"><section class="panel wide-card">'
      + '<div class="knowledge-search"><span>⌕</span><input id="knowledge-input" placeholder="搜索法规、预案、标准、案例或设备手册…">'
      + '<button data-action="knowledge-search">知识检索</button></div>'
      + '<div class="knowledge-tabs">' + tabs + '</div>'
      + '<div class="knowledge-list">' + docs + '</div></section>'
      + '<aside class="panel side-card"><div class="panel-title"><strong>知识概览</strong></div><div class="knowledge-cloud">' + cloud + '</div>'
      + '<div class="citation-tip"><b>可信引用</b><p>Agent 回答会保留知识来源、版本和引用片段，便于审核追溯。</p></div></aside></div>';
  }

  // ================= 抽屉 / 通知 / 弹窗 / toast =================
  function renderOverlays() {
    var root = $('#overlay-root');
    if (root === null) return;
    var html = '';
    if (state.drawer !== null) html += drawerHtml(state.drawer);
    if (state.notificationsOpen) html += notificationsHtml();
    if (state.modal !== null) html += modalHtml(state.modal);
    if (state.toast) html += '<div class="toast" role="status"><span>✓</span>' + esc(state.toast) + '</div>';
    root.innerHTML = html;
  }

  function drawerHtml(name) {
    var d = state.data;
    if (d === null) return '';
    var body = '';
    if (name === 'data') {
      var summary = '<div class="drawer-summary"><div><strong>18</strong><span>数据源</span></div><div><strong>17</strong><span>运行正常</span></div><div><strong>1</strong><span>需要关注</span></div></div>';
      var rows = d.system.sources.map(function (s) {
        var tone = s[2] === '正常' ? 'green' : 'amber';
        return '<article class="source-row"><i class="' + tone + '"></i><div><b>' + esc(s[0]) + '</b><span>' + esc(s[1]) + '</span></div><em>' + esc(s[2]) + '</em>'
          + '<button data-action="notify" data-msg="' + esc(s[0]) + '连接测试成功">测试</button></article>';
      }).join('');
      body = summary + '<h3>实时连接</h3>' + rows + '<button class="primary-action block" data-action="notify" data-msg="已创建新的数据源配置">＋ 添加数据源</button>';
    } else if (name === 'model') {
      var m = d.system.models;
      var routes = m.routes.map(function (r) {
        return '<label class="route-row"><span>' + esc(r[0]) + '</span><select><option>' + esc(r[1]) + '</option><option>DeepSeek V4 Pro</option><option>规则引擎</option></select></label>';
      }).join('');
      body = '<div class="model-active"><span>当前推理模型</span><strong>' + esc(m.current) + '</strong><small>长上下文 · 工具调用 · 深度思考</small><i>运行中</i></div>'
        + '<h3>任务路由</h3>' + routes
        + '<h3>推理控制</h3><label class="range-row"><span>严谨度 <b>0.8</b></span><input type="range" min="0" max="10" value="8"></label>'
        + '<button class="primary-action block" data-action="notify" data-msg="模型设置已保存">保存模型设置</button>';
    } else if (name === 'plugin') {
      var entries = d.system.plugins.map(function (p, index) {
        var on = state.enabledPlugins[p[0]] !== false;
        return '<article class="plugin-row"><span>' + PLUGIN_ICONS[index % PLUGIN_ICONS.length] + '</span><div><b>' + esc(p[0]) + '</b><small>' + esc(p[1]) + '</small></div>'
          + '<button class="switch ' + (on ? 'on' : '') + '" data-action="toggle-plugin" data-name="' + esc(p[0]) + '" aria-pressed="' + on + '"><i></i></button></article>';
      }).join('');
      var onCount = d.system.plugins.filter(function (p) { return state.enabledPlugins[p[0]] !== false; }).length;
      body = '<div class="plugin-heading"><span>一切皆插件</span><b>' + onCount + ' / ' + d.system.plugins.length + ' 已启用</b></div>' + entries
        + '<button class="secondary-action block" data-action="notify" data-msg="插件市场已载入 299+ 个能力">浏览插件市场</button>';
    } else {
      var list = d.system.logs.map(function (row) {
        return '<article><time>' + esc(row[0]) + '</time><i class="' + esc(row[3]) + '"></i><div><b>' + esc(row[1]) + '</b><span>' + esc(row[2]) + '</span></div></article>';
      }).join('');
      body = '<div class="log-filter"><button class="active">全部</button><button>Agent</button><button>工具</button><button>系统</button></div>'
        + '<div class="log-list">' + list + '</div>'
        + '<button class="secondary-action block" data-action="notify" data-msg="完整运行轨迹已导出">导出运行轨迹</button>';
    }
    return '<aside class="utility-drawer"><header><div><span>' + DRAWER_ICONS[name] + '</span><strong>' + DRAWER_TITLES[name] + '</strong></div>'
      + '<button data-action="close-drawer" aria-label="关闭">×</button></header><div class="drawer-content">' + body + '</div></aside>';
  }

  function notificationsHtml() {
    var d = state.data;
    if (d === null) return '';
    var items = d.system.notifications.map(function (n) {
      return '<button data-action="view-notification" data-msg="已查看：' + esc(n[1]) + '"><i class="' + esc(n[3]) + '"></i><div><b>' + esc(n[0]) + '</b><span>' + esc(n[1]) + '</span><time>' + esc(n[2]) + '</time></div></button>';
    }).join('');
    return '<aside class="notifications"><header><strong>通知中心</strong><button data-action="close-notifications">×</button></header>'
      + items + '<footer><button data-action="notify" data-msg="所有通知已标记为已读">全部标为已读</button></footer></aside>';
  }

  function modalHtml(name) {
    var headerIcon = name === 'schedule' ? '⌘' : name === 'report' ? '▣' : '⌕';
    var headerTitle = name === 'schedule' ? '生成联合调度方案' : name === 'report' ? '生成水务报告' : '全局搜索与指令';
    var headerSub = name === 'command' ? '搜索模块、数据和 Agent 指令' : '由城市水资源管理 Agent 协助完成';
    var body = '';
    if (name === 'command') {
      var items = COMMAND_ITEMS.map(function (item, index) {
        return '<button data-action="run-command" data-text="' + esc(item) + '"><kbd>⌘ ' + (index + 1) + '</kbd><span>' + esc(item) + '</span><i>›</i></button>';
      }).join('');
      body = '<div class="command-body"><label><span>⌕</span><input id="command-input" placeholder="输入关键词或直接描述任务…"></label><h3>推荐操作</h3>' + items + '</div>';
    } else if (name === 'schedule') {
      var meta = state.data ? state.data.scenariosMeta : { kinds: [], periods: [], regions: [] };
      var tabs = meta.kinds.map(function (k) {
        return '<button class="' + (state.scenario === k[0] ? 'active' : '') + '" data-action="set-scenario" data-value="' + esc(k[0]) + '">' + esc(k[0]) + '</button>';
      }).join('');
      var periods = meta.periods.map(function (p) { return '<option>' + esc(p) + '</option>'; }).join('');
      var regions = meta.regions.map(function (r) { return '<option>' + esc(r) + '</option>'; }).join('');
      body = '<div class="modal-form"><div class="scenario-tabs">' + tabs + '</div>'
        + '<div class="form-grid"><label><span>调度时段</span><select id="schedule-period">' + periods + '</select></label>'
        + '<label><span>目标区域</span><select id="schedule-region">' + regions + '</select></label>'
        + '<label class="full"><span>水库增供上限 <b>' + state.supplyCap + '.0万m³/日</b></span><input type="range" id="supply-cap" min="1" max="10" value="' + state.supplyCap + '"></label>'
        + '<label class="full"><span>管网压力调整上限 <b>0.0' + state.pressureCap + 'MPa</b></span><input type="range" id="pressure-cap" min="1" max="10" value="' + state.pressureCap + '"></label></div>'
        + '<div class="approval-note"><i>!</i><div><b>安全审批</b><p>此操作仅生成模拟方案，不会直接控制生产系统。方案下发仍需人工审批。</p></div></div>'
        + '<footer><button class="secondary-action" data-action="close-modal">取消</button>'
        + '<button class="primary-action" data-action="run-schedule">✦ 开始推演</button></footer></div>';
    } else {
      var kinds = state.data ? state.data.reportMeta.kinds : [];
      var kindRows = kinds.map(function (k, index) {
        var icons = ['日', '专', '复'];
        return '<button class="' + (state.reportType === k[0] ? 'active' : '') + '" data-action="set-report-type" data-value="' + esc(k[0]) + '"><span>' + icons[index % 3] + '</span><div><b>' + esc(k[0]) + '</b><small>' + esc(k[1]) + '</small></div></button>';
      }).join('');
      body = '<div class="modal-form"><div class="report-types">' + kindRows + '</div>'
        + '<label class="check-row"><input type="checkbox" id="report-charts" ' + (state.reportCharts ? 'checked' : '') + '>包含数据图表</label>'
        + '<label class="check-row"><input type="checkbox" id="report-cites" ' + (state.reportCites ? 'checked' : '') + '>附研判依据与引用</label>'
        + '<label class="check-row"><input type="checkbox" id="report-summary" ' + (state.reportSummary ? 'checked' : '') + '>生成领导摘要</label>'
        + '<footer><button class="secondary-action" data-action="notify" data-msg="报告模板已预览">预览模板</button>'
        + '<button class="primary-action" data-action="run-report">✦ 生成报告</button></footer></div>';
    }
    return '<div class="modal-backdrop" data-action="backdrop"><section class="modal ' + name + '" role="dialog" aria-modal="true">'
      + '<header><div><span>' + headerIcon + '</span><div><strong>' + headerTitle + '</strong><small>' + headerSub + '</small></div></div>'
      + '<button data-action="close-modal">×</button></header>' + body + '</section></div>';
  }

  function renderToast() {
    var root = $('#overlay-root');
    if (root === null) return;
    var el = $('#toast-el', root);
    if (state.toast) {
      if (el === null) {
        el = document.createElement('div');
        el.id = 'toast-el';
        root.appendChild(el);
      }
      el.innerHTML = '<div class="toast" role="status"><span>✓</span>' + esc(state.toast) + '</div>';
    } else if (el !== null) {
      el.remove();
    }
  }

  function openModal(name) {
    state.modal = name;
    if (name === 'schedule') state.scenario = '安全优先';
    if (name === 'report') state.reportType = '市级运行简报';
    renderOverlays();
  }
  function closeModal() { state.modal = null; renderOverlays(); }
  function runPrompt(text) {
    closeModal();
    state.activeNav = '综合研判';
    renderAll();
    window.setTimeout(function () { submitPrompt(text); }, 30);
  }
  function askAgent(query) {
    state.activeNav = '综合研判';
    renderAll();
    window.setTimeout(function () { submitPrompt(query); }, 30);
  }

  // ---------- 事件委托 ----------
  function onClick(event) {
    var el = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
    if (el === null) return;
    var action = el.getAttribute('data-action');
    var target = event.target.closest('.modal') ? event.target : el; // backdrop 关闭支持
    switch (action) {
      case 'navigate':
        state.activeNav = el.getAttribute('data-nav') || '综合研判';
        renderAll();
        break;
      case 'nav-overview':
        state.activeNav = '综合研判';
        renderAll();
        break;
      case 'cycle-city': cycleCity(); break;
      case 'open-command': openModal('command'); break;
      case 'back-to-chat': backToChat(); break;
      case 'toggle-notifications':
        state.notificationsOpen = !state.notificationsOpen;
        renderOverlays();
        break;
      case 'close-notifications': state.notificationsOpen = false; renderOverlays(); break;
      case 'view-notification':
        state.notificationsOpen = false;
        renderOverlays();
        notify(el.getAttribute('data-msg') || '已查看');
        break;
      case 'avatar': notify('当前账号：水务调度管理员'); break;
      case 'toggle-drawer':
        state.drawer = state.drawer === el.getAttribute('data-drawer') ? null : el.getAttribute('data-drawer');
        renderAll();
        break;
      case 'close-drawer': state.drawer = null; renderAll(); break;
      case 'quick-prompt': submitPrompt(el.getAttribute('data-text')); break;
      case 'ask-agent': askAgent(el.getAttribute('data-query')); break;
      case 'refresh': notify('态势数据已刷新'); void loadData(currentCity()); break;
      case 'open-schedule': openModal('schedule'); break;
      case 'open-report': openModal('report'); break;
      case 'close-modal': closeModal(); break;
      case 'backdrop':
        if (event.target === el) closeModal();
        break;
      case 'run-command': runPrompt(el.getAttribute('data-text')); break;
      case 'run-schedule':
        runPrompt('以' + state.scenario + '为目标，生成' + state.schedulePeriod + '（' + state.scheduleRegion + '）联合调度方案，水库增供上限' + state.supplyCap + '万m³/日');
        break;
      case 'run-report': {
        var parts = [];
        if (state.reportCharts) parts.push('图表');
        if (state.reportCites) parts.push('研判依据');
        if (state.reportSummary) parts.push('领导摘要');
        runPrompt('生成' + state.reportType + '，包含' + (parts.length > 0 ? parts.join('、') : '核心结论'));
        break;
      }
      case 'set-scenario': state.scenario = el.getAttribute('data-value') || '安全优先'; renderOverlays(); break;
      case 'set-report-type': state.reportType = el.getAttribute('data-value') || '市级运行简报'; renderOverlays(); break;
      case 'toggle-plugin': {
        var name = el.getAttribute('data-name');
        if (name !== null) state.enabledPlugins[name] = state.enabledPlugins[name] === false;
        renderOverlays();
        break;
      }
      case 'topo-node':
        state.selectedNode = el.getAttribute('data-node') || state.selectedNode;
        renderPage();
        break;
      case 'topo-analyze': {
        var nodeName = el.getAttribute('data-node') || '';
        if (nodeName !== '') state.selectedNode = nodeName;
        state.prompt = '请分析' + nodeName + '当前供水风险';
        renderPage();
        window.setTimeout(function () {
          var input = $('#composer-input');
          if (input !== null) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
        }, 30);
        notify('已带入节点：' + nodeName + '，按 Enter 发送');
        break;
      }
      case 'ack': {
        var id = el.getAttribute('data-id');
        if (id !== null && state.acknowledged.indexOf(id) === -1) state.acknowledged.push(id);
        renderPage();
        break;
      }
      case 'knowledge-search': {
        var input = $('#knowledge-input');
        notify('已检索 236 条相关知识' + (input && input.value.trim() ? '（' + input.value.trim() + '）' : ''));
        break;
      }
      case 'notify': notify(el.getAttribute('data-msg') || '操作完成'); break;
      default: break;
    }
  }

  function onKeyDown(event) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openModal('command');
      var input = $('#command-input');
      if (input !== null) window.setTimeout(function () { input.focus(); }, 40);
    }
    if (event.key === 'Escape') {
      if (state.modal !== null) closeModal();
      else if (state.drawer !== null) { state.drawer = null; renderAll(); }
      else if (state.notificationsOpen) { state.notificationsOpen = false; renderOverlays(); }
    }
  }

  // ---------- 启动 ----------
  function boot() {
    // 初始化插件开关（默认前 4 开、后 2 关，与原原型一致）
    if (state.data) {
      var plugins = state.data.system.plugins.map(function (p) { return p[0]; });
      plugins.forEach(function (name, index) { state.enabledPlugins[name] = index < 4; });
      state.messages = [
        { role: 'assistant', text: state.data.agent.greeting, time: '08:30' },
        { role: 'user', text: '分析未来72小时城区供水风险，并给出调度建议。', time: '08:31' },
        { role: 'assistant', text: '总体风险中低。北部片区晚高峰存在' + state.data.forecast.gap + '万m³缺口风险，建议从崂山水库增供并优化城阳供水区联动。', time: '08:35' },
      ];
    }
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeyDown);
    renderAll();
    probeHost();
    window.setInterval(probeHost, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
