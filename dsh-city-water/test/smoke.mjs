/**
 * dsh-city-water 宿主插件冒烟测试（无需启动完整 DSH）。
 * 用最小 ctx 桩验证：路由注册、静态服务、数据 API、快照注入、工具注册、系统提示节。
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..', 'lib', 'index.js');
const SKILL_DIR = mkdtempSync(join(tmpdir(), 'cw-skill-'));

const routes = [];
const sections = [];
const tools = [];

let effectPromise;
const ctx = {
  logger: { info: (m) => console.log('  [log]', String(m)) },
  webServer: {
    register: (route) => { routes.push(route); return () => {}; },
  },
  systemPrompt: {
    section: (s) => { sections.push(s); return () => {}; },
  },
  tools: {
    register: (t) => { tools.push(t); return () => {}; },
  },
  effect: (fn) => { effectPromise = fn(); },
};

let failed = 0;
function check(name, cond) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failed += 1;
}

const plugin = await import(PLUGIN);
plugin.apply(ctx, { skillDir: SKILL_DIR });
await effectPromise;

console.log('# 1. 资源注册');
check('路由注册数 >= 5', routes.length >= 5);
check('系统提示节已注册', sections.length === 1 && sections[0].name === 'plugin:dsh-city-water');
check('系统提示节顺序 210', sections[0].order === 210);
check('系统提示节含审批红线', sections[0].text.includes('人工审批'));
check('系统提示节提及 city-water 技能', sections[0].text.includes('city-water'));
const toolNames = tools.map((t) => t.name).sort();
check('注册 3 个只读工具', toolNames.join(',') === 'water_overview,water_report_draft,water_risk');

console.log('# 1b. 技能同步');
const syncedSkill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
check('SKILL.md 已同步到 skill 根', syncedSkill.includes('---'));
check('技能名 city-water', syncedSkill.includes('name: city-water'));
check('技能含研判 SOP', syncedSkill.includes('研判 SOP'));
check('技能含安全红线', syncedSkill.includes('安全红线'));

// 构造一个本地 http server，把所有请求打到路由表
const server = createServer((req, res) => {
  Object.defineProperty(req, 'socket', { value: { remoteAddress: '127.0.0.1' }, configurable: true });
  req.headers.host = '127.0.0.1:3080';
  const url = new URL(req.url, 'http://x');
  let handled = false;
  for (const route of routes) {
    const hit = route.kind === 'exact' ? url.pathname === route.path : url.pathname.startsWith(route.path);
    if (!hit) continue;
    route.handler(req, res);
    handled = true;
    break;
  }
  if (!handled) { res.writeHead(404); res.end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function get(path) {
  const res = await fetch(`${base}${path}`);
  const body = await res.text();
  return { status: res.status, type: res.headers.get('content-type'), body };
}

console.log('# 2. 静态工作台');
const root = await get('/api/dsh-city-water/workbench/');
check('workbench/ 200 text/html', root.status === 200 && root.type.includes('text/html'));
check('页面含 __CW_DATA__ 快照注入', root.body.includes('window.__CW_DATA__ = '));
check('快照含演示数据标记', root.body.includes('"source":"demo"'));
const css = await get('/api/dsh-city-water/workbench/water.css');
check('water.css 200', css.status === 200 && css.type.includes('text/css'));
const js = await get('/api/dsh-city-water/workbench/water.js');
check('water.js 200', js.status === 200 && js.type.includes('javascript'));
const traversal = await get('/api/dsh-city-water/workbench/%2e%2e%2f%2e%2e%2fetc%2fpasswd');
check('路径穿越 404', traversal.status === 404);
const notfound = await get('/api/dsh-city-water/workbench/nope.html');
check('未知文件 404', notfound.status === 404);

console.log('# 3. 数据 API');
const info = await get('/api/dsh-city-water/api/info');
check('api/info 200 json', info.status === 200 && info.type.includes('json'));
const overview = await get('/api/dsh-city-water/api/overview?city=%E6%B5%8E%E5%8D%97%E5%B8%82');
const overviewJson = JSON.parse(overview.body);
check('overview 济南 200', overview.status === 200 && overviewJson.data.meta.city === '济南市');
check('overview 含 4 指标', overviewJson.data.metrics.length === 4);
check('overview 含 7 模块', Object.keys(overviewJson.data.modules).length === 6);
const module404 = await get('/api/dsh-city-water/api/module/nope');
check('未知模块 404', module404.status === 404);
const mod = await get('/api/dsh-city-water/api/module/%E9%A3%8E%E9%99%A9%E9%A2%84%E8%AD%A6');
const modJson = JSON.parse(mod.body);
check('风险预警模块数据', mod.status === 200 && modJson.data.alerts.length === 3);
const sys = await get('/api/dsh-city-water/api/system/logs');
check('system/logs 数据', sys.status === 200 && JSON.parse(sys.body).data.length === 5);

console.log('# 3b. 对话通道（演示模式 SSE）');
const chat = await fetch(`${base}/api/dsh-city-water/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: '分析未来72小时供水风险', city: '青岛市', history: [] }),
});
const chatBody = await chat.text();
check('chat 200 SSE', chat.status === 200 && chat.headers.get('content-type').includes('text/event-stream'));
check('chat 含 delta 事件', chatBody.includes('event: delta'));
check('chat 含 done(demo) 事件', chatBody.includes('event: done') && chatBody.includes('"mode":"demo"'));
check('chat 演示结论含数据', chatBody.includes('供水') || chatBody.includes('万m³'));
const chatHi = await fetch(`${base}/api/dsh-city-water/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: '你好', city: '青岛市', history: [] }),
});
const chatHiBody = await chatHi.text();
check('演示模式通用问候', chatHiBody.includes('你好，我是'));
const chatEmpty = await fetch(`${base}/api/dsh-city-water/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: '   ' }),
});
check('空任务 400', chatEmpty.status === 400);
const chatBadJson = await fetch(`${base}/api/dsh-city-water/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: 'not-json',
});
check('坏 JSON 400', chatBadJson.status === 400);

console.log('# 4. 工具可执行');
const overviewTool = tools.find((t) => t.name === 'water_overview');
const out = await overviewTool.execute({ city: '青岛市' });
check('water_overview 返回文本', typeof out.text === 'string' && out.text.includes('演示数据'));
const riskTool = tools.find((t) => t.name === 'water_risk');
const riskOut = await riskTool.execute({ city: '青岛市', scope: '洪涝' });
check('water_risk 按范围过滤', riskOut.text.includes('洪涝') && riskOut.text.includes('A-20260820-031'));
const reportTool = tools.find((t) => t.name === 'water_report_draft');
const reportOut = await reportTool.execute({ kind: '日报', city: '青岛市' });
check('water_report_draft 草稿', reportOut.text.includes('草稿') && reportOut.text.includes('人工审核'));

server.close();
console.log(failed === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
