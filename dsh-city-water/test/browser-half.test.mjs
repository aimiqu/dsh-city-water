/**
 * 浏览器半 + 工作台页面集成测试（jsdom + 真实宿主路由）。
 *
 * 覆盖：
 *  1. 客户端插件：侧栏入口注入、面板 iframe、互斥属性、任务桥 → 原生 composer 写入、关闭面板消息
 *  2. 工作台页面：渲染 7 模块、任务装配动画 → 任务桥 postMessage、模块切换、抽屉/弹窗
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { JSDOM } from '/Users/vitcou/projects/deepseek/deepseek-harness/node_modules/jsdom/lib/api.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const clientCode = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
const html = readFileSync(join(ROOT, 'workbench', 'index.html'), 'utf8');

let failed = 0;
function check(name, cond) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failed += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 3000, step = 25) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await sleep(step);
  }
  return fn();
}

// ---------------- 真实宿主路由 ----------------
const { buildWaterData } = await import(join(ROOT, 'lib', 'water-data.js'));
const server = createServer((req, res) => {
  Object.defineProperty(req, 'socket', { value: { remoteAddress: '127.0.0.1' }, configurable: true });
  req.headers.host = '127.0.0.1:9';
  const url = new URL(req.url, 'http://x');
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
  if (url.pathname === '/api/dsh-city-water/workbench/' || url.pathname === '/api/dsh-city-water/workbench') {
    const snapshot = JSON.stringify(buildWaterData('青岛市')).replaceAll('<', '\\u003c');
    return send(200, 'text/html; charset=utf-8', html.replace('<!--CW_DATA-->', `<script>window.__CW_DATA__ = ${snapshot}</script>`));
  }
  if (url.pathname === '/api/dsh-city-water/workbench/water.css') {
    return send(200, 'text/css', readFileSync(join(ROOT, 'workbench', 'water.css'), 'utf8'));
  }
  if (url.pathname === '/api/dsh-city-water/workbench/water.js') {
    return send(200, 'text/javascript', readFileSync(join(ROOT, 'workbench', 'water.js'), 'utf8'));
  }
  if (url.pathname === '/api/dsh-city-water/api/info') return send(200, 'application/json', JSON.stringify({ ok: true, cities: ['青岛市', '济南市', '烟台市'] }));
  if (url.pathname === '/api/dsh-city-water/chat' && req.method === 'POST') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
      if (!parsed.message || !parsed.message.trim()) { res.writeHead(400); res.end(); return; }
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write('event: status\ndata: {"step":"tool","tool":"water_overview","phase":"running"}\n\n');
      await delay(50);
      res.write('event: status\ndata: {"step":"tool","tool":"water_overview","phase":"done"}\n\n');
      await delay(50);
      res.write('event: delta\ndata: {"text":"综合研判完成：未来72小时全市供水总体可控，北部片区晚高峰存在缺口。"}\n\n');
      await delay(80);
      res.write('event: done\ndata: {"mode":"demo"}\n\n');
      res.end();
    });
    return;
  }
  if (url.pathname === '/api/dsh-city-water/api/overview') {
    const city = decodeURIComponent(url.searchParams.get('city') ?? '青岛市');
    return send(200, 'application/json', JSON.stringify({ ok: true, city, source: 'demo', data: buildWaterData(city) }));
  }
  if (url.pathname.startsWith('/api/dsh-city-water/api/module')) {
    const mod = decodeURIComponent(url.pathname.split('/').pop());
    const data = buildWaterData('青岛市');
    if (data.modules[mod]) return send(200, 'application/json', JSON.stringify({ ok: true, data: data.modules[mod] }));
    return send(404, 'application/json', JSON.stringify({ ok: false }));
  }
  send(404, 'text/plain', 'not found');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---------------- 1. 客户端插件（jsdom） ----------------
console.log('# 1. 客户端插件');
{
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body>
      <div data-pane="sidebar"><div class="logoRow"><button class="newSession">New</button></div></div>
      <div data-pane="conversation"><div data-composer-seat><textarea id="composer"></textarea></div></div>
    </body></html>`,
    { url: BASE, runScripts: 'outside-only', pretendToBeVisual: true },
  );
  const { window } = dom;
  let registration;
  window.__ModuleLoader__ = { load: (reg) => { registration = reg; } };
  window.eval(clientCode);
  check('模块已注册', registration !== undefined && registration.id === 'dsh-city-water');
  const exportsObj = registration.factory();
  check('导出 apply/inject', typeof exportsObj.apply === 'function' && Array.isArray(exportsObj.inject));

  let disposer;
  exportsObj.apply({
    effect: (fn) => { disposer = fn(); },
  });

  const entry = await waitFor(() => window.document.querySelector('[data-dsh-city-water-entry]'));
  check('侧栏入口注入', entry !== null);
  check('入口文案', entry !== null && entry.textContent.includes('城市水智管'));

  entry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const view = await waitFor(() => window.document.querySelector('[data-dsh-city-water-view]'));
  const frame = view !== null ? view.querySelector('iframe') : null;
  check('点击后面板出现', view !== null);
  check('iframe 指向工作台', frame !== null && frame.src === BASE + '/api/dsh-city-water/workbench/');
  check('激活属性', window.document.documentElement.getAttribute('data-dsh-city-water-active') === 'true');

  // 任务桥：模拟 iframe postMessage → 面板关闭 + composer 写入
  const composer = window.document.getElementById('composer');
  // jsdom 不做布局：补齐 getBoundingClientRect 使浏览器启发式筛选可用
  composer.getBoundingClientRect = () => ({ width: 500, height: 40, top: 0, left: 0, right: 500, bottom: 40 });
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'dsh-city-water:task', text: '研判未来72小时供水风险' },
    origin: window.location.origin,
    source: frame.contentWindow,
  }));
  await sleep(60);
  check('任务桥后关闭面板', window.document.documentElement.getAttribute('data-dsh-city-water-active') !== 'true');
  check('composer 已写入任务', composer.value === '研判未来72小时供水风险');

  // 再开面板，验证关闭消息
  entry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'dsh-city-water:close' },
    origin: window.location.origin,
    source: frame.contentWindow,
  }));
  await sleep(30);
  check('关闭消息生效', window.document.documentElement.getAttribute('data-dsh-city-water-active') !== 'true');

  // 互斥：其他面板激活事件会让位
  entry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  window.document.dispatchEvent(new window.CustomEvent('dsh-panel-activate', { detail: 'lawbench' }));
  await sleep(30);
  check('面板互斥让位', window.document.documentElement.getAttribute('data-dsh-city-water-active') !== 'true');

  disposer();
  window.close();
}

// ---------------- 2. 工作台页面（jsdom + fetch 桥） ----------------
console.log('# 2. 工作台页面');
{
  const snapshot = JSON.stringify(buildWaterData('青岛市')).replaceAll('<', '\\u003c');
  const pageHtml = html.replace('<!--CW_DATA-->', `<script>window.__CW_DATA__ = ${snapshot}</script>`);
  const dom = new JSDOM(pageHtml, {
    url: `${BASE}/api/dsh-city-water/workbench/`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  // 桥：页面 fetch 走真实宿主路由
  window.fetch = (input, init) => fetch(new URL(String(input), window.location.href).href, init);
  const posted = [];
  const parentSpy = { postMessage: (data, origin) => posted.push({ data, origin }) };
  let bridgeMode = 'standalone';
  try {
    Object.defineProperty(window, 'parent', { value: parentSpy, configurable: true });
    bridgeMode = 'iframe';
  } catch (e) { /* jsdom 限制时走独立标签页路径 */ }

  // 执行 water.js（html 里的 <script> 不会被 jsdom 执行，手动注入快照与脚本）
  window.eval(`window.__CW_DATA__ = ${JSON.stringify(buildWaterData('青岛市')).replaceAll('<', '\\u003c')};`);
  window.eval(readFileSync(join(ROOT, 'workbench', 'water.js'), 'utf8'));
  await sleep(100);

  check('导航 7 项', window.document.querySelectorAll('#main-nav .nav-item').length === 7);
  check('指标卡 4 张', window.document.querySelectorAll('.metric-card').length === 4);
  check('宿主在线状态', window.document.getElementById('host-status').textContent.includes('在线'));

  // 模块切换
  const moduleNav = Array.from(window.document.querySelectorAll('#main-nav .nav-item')).find((b) => b.textContent.includes('水情监测'));
  moduleNav.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  check('水情监测站点表', window.document.querySelectorAll('.table-row').length === 5);

  const riskNav = Array.from(window.document.querySelectorAll('#main-nav .nav-item')).find((b) => b.textContent.includes('风险预警'));
  riskNav.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  check('风险预警清单', window.document.querySelectorAll('.alert-list article').length === 3);

  // 签收处置
  const ackBtn = window.document.querySelector('.alert-list article button');
  ackBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  check('签收后状态', window.document.querySelector('.alert-list article button').textContent === '已签收');

  // 抽屉
  const drawerBtn = Array.from(window.document.querySelectorAll('.utility-rail button')).find((b) => b.getAttribute('data-drawer') === 'plugin');
  drawerBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  check('插件抽屉', window.document.querySelectorAll('.utility-drawer .plugin-row').length === 6);
  const firstSwitch = window.document.querySelector('.plugin-row .switch');
  firstSwitch.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  check('插件开关切换', window.document.querySelector('.plugin-row .switch').classList.contains('on') === false);
  window.document.querySelector('.utility-drawer header button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(30);

  // 弹窗（调度）：切到供需调度页再触发
  const dispatchNav = Array.from(window.document.querySelectorAll('#main-nav .nav-item')).find((b) => b.textContent.includes('供需调度'));
  dispatchNav.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const scheduleBtn = window.document.querySelector('[data-action="open-schedule"]');
  check('供需调度页有推演入口', scheduleBtn !== null);
  scheduleBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  check('调度弹窗', window.document.querySelector('.modal.schedule') !== null);
  check('审批提示', window.document.querySelector('.approval-note') !== null);
  window.document.querySelector('[data-action="close-modal"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(30);

  // 面板内直连对话（回综合研判页，流式 SSE）
  const overviewNav = Array.from(window.document.querySelectorAll('#main-nav .nav-item')).find((b) => b.textContent.includes('综合研判'));
  overviewNav.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const input = window.document.getElementById('composer-input');
  input.value = '分析未来72小时供水风险';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(30);
  const send = window.document.getElementById('send-btn');
  check('发送按钮可用', send.disabled === false);
  send.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const taskBox = await waitFor(() => window.document.querySelector('.task-box'));
  check('工具步出现', taskBox !== null);
  const stepLabel = await waitFor(() => window.document.querySelector('.task-box li'));
  check('工具步显示数据汇集', stepLabel !== null && stepLabel.textContent.includes('汇集态势数据'));
  const streamBubble = await waitFor(() => window.document.querySelector('#assistant-stream'), 5000);
  check('流式气泡出现', streamBubble !== null);
  const modeBadge = await waitFor(() => window.document.querySelector('.mode-badge'), 8000);
  check('回答含模式徽标', modeBadge !== null);
  check('演示模式徽标', modeBadge.textContent.includes('演示模式'));
  const finalText = await waitFor(() => {
    const bubble = window.document.querySelector('.bubble.conclusion');
    return bubble && bubble.textContent.includes('综合研判完成') ? bubble.textContent : '';
  }, 8000);
  check('回答内容完整呈现', finalText !== '' && finalText.includes('北部片区'));
  check('无任务转交行', window.document.querySelector('.bridge-row') === null);
  check('无任务桥消息发出', posted.length === 0);

  // 城市切换
  const cityBtn = window.document.querySelector('[data-action="cycle-city"]');
  cityBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  check('城市切换为济南', window.document.getElementById('city-name').textContent === '济南市');

  window.close();
}

server.close();
console.log(failed === 0 ? '\nBROWSER-HALF OK' : `\nBROWSER-HALF FAILED: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
