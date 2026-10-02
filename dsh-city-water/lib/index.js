/**
 * dsh-city-water 宿主半：在 DeepSeek Harness（DSH）进程内拉起「城市水智管」能力。
 *
 * 能力清单：
 * 1. 静态服务 /api/dsh-city-water/workbench/* —— 工作台页面（同源 iframe 用）
 * 2. 数据 API  /api/dsh-city-water/api/*        —— 水务演示数据（单一事实源）
 * 3. 对话通道  /api/dsh-city-water/chat         —— 工作台面板内流式对话（SSE）：
 *    配置 DeepSeek 密钥走真实模型 + 水务工具循环；无密钥自动回退演示模式
 * 4. 只读工具   water_overview / water_risk / water_report_draft
 *              —— 原生会话中的 Agent 同样可直接调用
 * 5. 系统提示节 plugin:dsh-city-water —— 向每个会话播报工作台入口、水务纪律与审批红线
 *
 * 安全设计：全部路由 loopback-only（只放行本机浏览器）；v1 工具与 API 只读，
 * 生产控制操作只生成方案、必须人工审批。
 *
 * @module dsh-city-water/lib/index
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, normalize, resolve } from 'node:path';
import { CITIES, buildWaterData, overviewSummary, riskSummary, reportDraft } from './water-data.js';
import { runChat } from './chat.js';

export const name = 'dsh-city-water';
export const inject = ['webServer', 'systemPrompt', 'tools'];

const BASE = '/api/dsh-city-water';
const WORKBENCH_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'workbench');
const STATIC_FILES = new Set(['index.html', 'water.css', 'water.js', 'manifest.json', 'sw.js', 'icon-180.png', 'icon-192.png', 'icon-512.png']);

const MODULE_NAMES = new Set(['水情监测', '供需调度', '风险预警', '河湖管理', '报告中心', '知识库']);
const SYSTEM_NAMES = new Set(['sources', 'models', 'plugins', 'logs']);

const ANNOUNCEMENT = `【城市水智管（dsh-city-water 插件）】
本机安装了「城市水智管 · 水资源管理 Agent」工作台，入口在 GUI 侧边栏「城市水智管」（点击在会话区打开，也可工具栏「在标签页打开」）。
职责：你是城市水资源管理 Agent，辅助水务人员完成监测、预警研判、供需调度与报告编制。
工作纪律：
1. 区分实时事实、模型预测与建议，不虚构未提供的监测数据；回答注明数据时间范围与不确定性。
2. 研判结论给出风险等级、关键依据与可执行建议。
3. 审批红线：任何可能影响真实生产系统的操作（泵站、闸门、管网、SCADA）只生成方案，绝不声称已经下发，必须等待人工审批。
4. 当前态势为演示数据（source=demo）；正式决策前提醒用户核验实时监测。
5. 工具：查询总体态势用 water_overview，查询风险与预警用 water_risk，起草报告用 water_report_draft；未安装或不可用时按纪律直接回答。
6. 工作台面板内的研判对话由本插件 /chat 通道承载（DeepSeek 直连 + 工具循环，无密钥时演示回退）；原生会话中同样可直接调用上述工具。
7. 本插件提供「city-water」技能（水资源管理：研判 SOP、指标阈值、调度框架、报告模板与安全红线）：原生会话可用 /city-water 显式调用，或由模型按需挂载；用户提到「水资源技能 / 水务 SOP」时即指该技能。
用户提到「水智管 / 工作台 / 看板 / 调度 / 预警 / 河湖 / 报告」时即指本插件。`;

/** 回环主机名集合（与 harness 自身 /api 信任栅栏一致）。 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** 归一化一条可信 authority（如 'dsh.yuxinqu.com' 或 'dsh.yuxinqu.com:3080'）为 hostname。 */
function trustedHostname(entry) {
  try { return new URL(`http://${entry}`).hostname; } catch { return null; }
}

/**
 * 从 harness 的 cmdlineArgs（根级服务，所有插件可见）解析 --trusted-host：
 * `dsh web --trusted-host dsh.yuxinqu.com` → ['dsh.yuxinqu.com']。
 * 兼容变长取值与可重复选项。
 */
function trustedHostsFromCmdline(cmdline) {
  const list = Array.isArray(cmdline) ? cmdline : [];
  const hosts = [];
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === '--trusted-host') {
      for (let j = i + 1; j < list.length; j += 1) {
        if (typeof list[j] !== 'string' || list[j].startsWith('-')) break;
        hosts.push(list[j]);
      }
    }
  }
  return hosts;
}

/**
 * 准入护栏（与 harness 的 api-request-trust 对齐：以 Host 为准，不强依赖 socket 来源）：
 * Host 为回环主机名，或命中部署声明的可信 authority（--trusted-host / webRuntime.trustedHosts），
 * 且非 cross-site、Origin 与 Host 同源（存在时）才放行。作为 /api 信任栅栏之后的一道护栏。
 */
function isLoopbackRequest(req, trusted = []) {
  if (!isHostAllowed(req, trusted)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try { return new URL(origin).host === new URL(`http://${req.headers.host}`).host; } catch { return false; }
}

/**
 * 仅校验 Host 是否可信（回环或声明可信主机），不做 sec-fetch-site / Origin 同源约束。
 * 用于公开入口（如 /go 加密短链，扫码/跨站点击属于预期行为），真正的鉴权由 HMAC 令牌承担。
 */
function isHostAllowed(req, trusted = []) {
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try { hostUrl = new URL(`http://${host}`); } catch { return false; }
  const hostname = hostUrl.hostname;
  return LOOPBACK_HOSTNAMES.has(hostname) || trusted.some((entry) => trustedHostname(entry) === hostname);
}

/** 加密短链访问密钥文件（默认插件目录下 .auth-secrets，已 gitignore；可用环境变量覆盖）。 */
const DEFAULT_AUTH_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.auth-secrets');

/** 生成加密短链令牌：`t.<expiresAtMs>.<nonce>.<hmac-hex>`，HMAC 密钥为 LINK_SECRET。 */
function signLinkToken(secret, expiresAtMs, nonce) {
  const payload = `t.${expiresAtMs}.${nonce}`;
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

/** 校验加密短链令牌（格式 + 未过期 + HMAC 签名，timing-safe 比较）。 */
function verifyLinkToken(secret, token, nowMs) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 't') return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp <= nowMs) return false;
  if (!/^[0-9a-f]{8,64}$/i.test(parts[2])) return false;
  if (!/^[0-9a-f]{64}$/i.test(parts[3])) return false;
  const expect = createHmac('sha256', secret).update(`t.${exp}.${parts[2]}`).digest('hex');
  const a = Buffer.from(expect);
  const b = Buffer.from(parts[3]);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 读取访问密钥：LINK_SECRET 用于签发限时短链；ACCESS_TOKEN 作为免密 cookie 值（需与
 * Caddyfile 中 @has_cookie 匹配器一致）；LINK_TOKEN 为长期有效的永久短链令牌（32 位 hex，
 * 可多行，删除对应行即吊销）。读取顺序：环境变量 → 密钥文件。
 */
function readAuthFile() {
  const file = process.env.DSH_CITY_WATER_AUTH_FILE || DEFAULT_AUTH_FILE;
  const out = {
    linkSecret: process.env.DSH_CITY_WATER_LINK_SECRET || '',
    accessToken: process.env.DSH_CITY_WATER_ACCESS_TOKEN || '',
    linkTokens: new Set(),
  };
  const envTokens = process.env.DSH_CITY_WATER_LINK_TOKENS || '';
  for (const t of envTokens.split(',')) if (t.trim()) out.linkTokens.add(t.trim());
  try {
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_]+)\s*=\s*([0-9a-fA-F]+)\s*$/);
        if (!m) continue;
        if (m[1] === 'LINK_SECRET' && !out.linkSecret) out.linkSecret = m[2];
        else if (m[1] === 'ACCESS_TOKEN' && !out.accessToken) out.accessToken = m[2];
        else if (m[1] === 'LINK_TOKEN') out.linkTokens.add(m[2]);
      }
    }
  } catch { /* ignore */ }
  return out;
}

/** 启动时读取/补齐访问密钥（缺失则自动生成并落盘）。 */
function loadAuthSecrets(log) {
  const file = process.env.DSH_CITY_WATER_AUTH_FILE || DEFAULT_AUTH_FILE;
  const secrets = readAuthFile();
  if (!secrets.linkSecret) secrets.linkSecret = randomBytes(32).toString('hex');
  if (!secrets.accessToken) secrets.accessToken = randomBytes(32).toString('hex');
  if (!existsSync(file)) {
    try {
      writeFileSync(file, `LINK_SECRET=${secrets.linkSecret}\nACCESS_TOKEN=${secrets.accessToken}\n`, { mode: 0o600 });
      log(`访问密钥已生成：${file}（ACCESS_TOKEN 需与 Caddyfile 的 @has_cookie 匹配器一致）`);
    } catch { /* ignore */ }
  }
  return secrets;
}

function writeJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
  });
  res.end(body);
}

function writeText(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-cache' });
  res.end(body);
}

/** 解析 query（city 等参数，带解码与白名单）。 */
function queryOf(req) {
  const url = new URL(req.url ?? '/', 'http://x');
  const city = decodeURIComponent(url.searchParams.get('city') ?? '青岛市');
  return { url, city: CITIES.includes(city) ? city : '青岛市' };
}

/**
 * 加载 @deepseek-ai/dsh-tools：
 * 1) 优先按包名解析（DSH 启动时会把安装闭包里的官方包符号链接到
 *    ~/.dsh/profiles/node_modules，插件从这里解析，与 dsh-sparkos 相同做法）；
 * 2) 失败时回退环境变量 DSH_TOOLS_PATH 指向的绝对路径（独立运行/测试用）。
 */
async function loadDshTools() {
  try {
    return await import('@deepseek-ai/dsh-tools');
  } catch (firstError) {
    const fallback = process.env.DSH_TOOLS_PATH;
    if (typeof fallback === 'string' && fallback.trim() !== '') {
      try {
        const target = fallback.trim().endsWith('.js') || fallback.trim().endsWith('.mjs')
          ? fallback.trim()
          : join(fallback.trim(), 'lib', 'index.js');
        return await import(pathToFileURL(resolve(target)).href);
      } catch { /* fall through */ }
    }
    throw firstError;
  }
}

export function apply(ctx, config = {}) {
  const log = (msg) => {
    try { ctx.logger?.info(msg); } catch { console.log(`[dsh-city-water] ${msg}`); }
  };

  // 部署可信主机：与 harness 自身 /api 信任栅栏对齐。
  // 优先从 cmdlineArgs（根级服务，任何插件可读）解析 --trusted-host；webRuntime 为
  // 特定行提供的服务，兄弟插件未必读得到，故仅作补充。可再经 config.trustedHosts 显式覆盖。
  let cmdTrusted = [];
  let webRuntimeTrusted = [];
  if (typeof ctx.get === 'function') {
    try { cmdTrusted = trustedHostsFromCmdline(ctx.get('cmdlineArgs')?.get?.()); } catch { /* ignore */ }
    try { webRuntimeTrusted = [...(ctx.get('webRuntime')?.trustedHosts ?? [])]; } catch { /* ignore */ }
  }
  const trustedHosts = [
    ...(Array.isArray(config.trustedHosts) ? config.trustedHosts : []),
    ...cmdTrusted,
    ...webRuntimeTrusted,
  ];

  // 启动时确保访问密钥存在（缺失则自动生成落盘）；/go 请求时再按需读最新令牌
  loadAuthSecrets(log);
  const cookieMaxAge = Math.max(1, Number(process.env.DSH_CITY_WATER_COOKIE_TTL_DAYS || 30)) * 86400;

  ctx.effect(async () => {
    const disposers = [];
    const announce = config.announceToAgent !== false;
    if (announce) {
      try {
        const dispose = ctx.systemPrompt.section({ name: 'plugin:dsh-city-water', order: 210, text: ANNOUNCEMENT });
        if (typeof dispose === 'function') disposers.push(dispose);
      } catch (error) {
        log(`系统提示节注册失败（仅降级，不影响界面）：${error?.message ?? error}`);
      }
    }

    // ---- city-water 技能同步到用户 skill 根（DSH 原生会话经 skill 系统挂载）----
    try {
      const skillDir = config.skillDir ?? join(homedir(), '.dsh', 'skills', 'city-water');
      mkdirSync(skillDir, { recursive: true });
      const skillSrc = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'city-water', 'SKILL.md');
      const skillDst = join(skillDir, 'SKILL.md');
      if (!existsSync(skillDst) || readFileSync(skillDst, 'utf8') !== readFileSync(skillSrc, 'utf8')) {
        copyFileSync(skillSrc, skillDst);
        log(`city-water 技能已同步：${skillDst}`);
      }
    } catch (error) {
      log(`技能同步失败（仅降级，不影响界面）：${error?.message ?? error}`);
    }

    // ---- 静态工作台页面 ----
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/workbench`,
      handler: (req, res) => {
        if (!isLoopbackRequest(req, trustedHosts)) return writeText(res, 403, 'loopback only');
        res.writeHead(302, { Location: `${BASE}/workbench/` });
        res.end();
      },
    }));
    disposers.push(ctx.webServer.register({
      kind: 'prefix',
      path: `${BASE}/workbench`,
      handler: (req, res) => {
        if (!isLoopbackRequest(req, trustedHosts)) return writeText(res, 403, 'loopback only');
        if (req.method !== 'GET' && req.method !== 'HEAD') return writeText(res, 405, 'method not allowed');
        const url = new URL(req.url ?? '/', 'http://x');
        const rel = decodeURIComponent(url.pathname.slice(`${BASE}/workbench`.length));
        const file = rel === '/' || rel === '' ? 'index.html' : rel.replace(/^\/+/, '');
        if (!STATIC_FILES.has(file)) return writeText(res, 404, 'not found');
        // 白名单文件名已杜绝路径穿越；normalize 双保险。
        const abs = resolve(normalize(join(WORKBENCH_DIR, file)));
        if (!abs.startsWith(resolve(WORKBENCH_DIR))) return writeText(res, 403, 'forbidden');
        try {
          let body = readFileSync(abs);
          // index.html 注入初始数据快照：接口不可用时工作台仍可离线展示演示数据。
          if (file === 'index.html' && body.includes('<!--CW_DATA-->')) {
            const { city } = queryOf(req);
            const snapshot = JSON.stringify(buildWaterData(city)).replaceAll('<', '\\u003c');
            body = Buffer.from(
              body.toString('utf8').replace('<!--CW_DATA-->', `<script>window.__CW_DATA__ = ${snapshot}</script>`),
            );
          }
          const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/manifest+json; charset=utf-8', '.png': 'image/png' };
          res.writeHead(200, { 'content-type': types[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
          res.end(req.method === 'HEAD' ? undefined : body);
        } catch {
          writeText(res, 404, 'not found');
        }
      },
    }));

    // ---- 加密短链免密授权：GET /api/dsh-city-water/go/<token> → 校验后种 cookie 并跳转工作台 ----
    disposers.push(ctx.webServer.register({
      kind: 'prefix',
      path: `${BASE}/go`,
      handler: (req, res) => {
        if (!isHostAllowed(req, trustedHosts)) return writeText(res, 403, 'loopback only');
        if (req.method !== 'GET' && req.method !== 'HEAD') return writeText(res, 405, 'method not allowed');
        const url = new URL(req.url ?? '/', 'http://x');
        const token = decodeURIComponent(url.pathname.slice(`${BASE}/go`.length).replace(/^\/+/, ''));
        const auth = readAuthFile(); // 每次读最新：新追加的永久 LINK_TOKEN 无需重启即生效
        const okPermanent = auth.linkTokens.has(token);
        const okTimed = verifyLinkToken(auth.linkSecret, token, Date.now());
        if (!okPermanent && !okTimed) {
          res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
          res.end('<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>链接无效</title></head><body style="font-family:system-ui,-apple-system,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;background:#08293f;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0"><div style="text-align:center;padding:2rem"><h1>访问链接无效或已过期</h1><p style="color:#cfe6f5">请向作者索取新的二维码 / 访问链接。</p></div></body></html>');
          return;
        }
        res.writeHead(302, {
          Location: `${BASE}/workbench/index.html`,
          'Set-Cookie': `cw_access=${auth.accessToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${cookieMaxAge}`,
          'cache-control': 'no-cache',
        });
        res.end();
      },
    }));

    // ---- 数据 API ----
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/api/info`,
      handler: (req, res) => {
        if (!isLoopbackRequest(req, trustedHosts)) return writeJson(res, 403, { ok: false, error: 'loopback only' });
        writeJson(res, 200, {
          ok: true, plugin: 'dsh-city-water', version: '0.1.0', cities: CITIES,
          source: 'demo', note: '演示数据模式；接入真实数据源后 source 变为 live',
        });
      },
    }));
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/api/overview`,
      handler: (req, res) => {
        if (!isLoopbackRequest(req, trustedHosts)) return writeJson(res, 403, { ok: false, error: 'loopback only' });
        const { city } = queryOf(req);
        const data = buildWaterData(city);
        writeJson(res, 200, { ok: true, city, generatedAt: data.meta.generatedAt, source: 'demo', data });
      },
    }));
    disposers.push(ctx.webServer.register({
      kind: 'prefix',
      path: `${BASE}/api/module`,
      handler: (req, res) => {
        if (!isLoopbackRequest(req, trustedHosts)) return writeJson(res, 403, { ok: false, error: 'loopback only' });
        const { url, city } = queryOf(req);
        const mod = decodeURIComponent(url.pathname.slice(`${BASE}/api/module`.length).replace(/^\/+/, ''));
        const data = buildWaterData(city);
        if (!MODULE_NAMES.has(mod)) return writeJson(res, 404, { ok: false, error: `unknown module: ${mod}` });
        writeJson(res, 200, { ok: true, city, module: mod, source: 'demo', data: data.modules[mod] });
      },
    }));
    disposers.push(ctx.webServer.register({
      kind: 'prefix',
      path: `${BASE}/api/system`,
      handler: (req, res) => {
        if (!isLoopbackRequest(req, trustedHosts)) return writeJson(res, 403, { ok: false, error: 'loopback only' });
        const { url, city } = queryOf(req);
        const key = decodeURIComponent(url.pathname.slice(`${BASE}/api/system`.length).replace(/^\/+/, ''));
        if (!SYSTEM_NAMES.has(key)) return writeJson(res, 404, { ok: false, error: `unknown system section: ${key}` });
        const data = buildWaterData(city);
        const value = key === 'sources' ? data.system.sources
          : key === 'models' ? data.system.models
            : key === 'plugins' ? data.system.plugins
              : data.system.logs;
        writeJson(res, 200, { ok: true, city, section: key, source: 'demo', data: value });
      },
    }));

    // ---- 面板内对话通道（SSE 流式；live 走 DeepSeek + 工具循环，无密钥演示回退）----
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/chat`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req, trustedHosts)) return writeJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method !== 'POST') return writeText(res, 405, 'method not allowed');
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 256 * 1024) return writeJson(res, 413, { ok: false, error: 'request too large' });
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return writeJson(res, 400, { ok: false, error: 'invalid json' }); }
        const message = typeof body?.message === 'string' ? body.message.trim() : '';
        if (message === '' || message.length > 4000) return writeJson(res, 400, { ok: false, error: '任务内容为空或过长' });
        const { city } = queryOf(req);
        const history = Array.isArray(body.history) ? body.history : [];

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const controller = new AbortController();
        res.on('close', () => controller.abort());

        try {
          const result = await runChat({
            city: CITIES.includes(body.city) ? body.city : city,
            message,
            history,
            apiKey: config.apiKey ?? process.env.DEEPSEEK_API_KEY,
            baseUrl: config.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
            model: config.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
            onStatus: (status) => { if (!res.writableEnded) sse('status', status); },
            onDelta: (text) => { if (!res.writableEnded) sse('delta', { text }); },
            signal: controller.signal,
          });
          if (!res.writableEnded) sse('done', { mode: result.mode });
        } catch (error) {
          if (!res.writableEnded) sse('error', { message: error?.message ?? String(error) });
        }
        if (!res.writableEnded) res.end();
      },
    }));

    // ---- 只读演示工具（原生 Agent 调用；后续在此扩展真实数据工具）----
    try {
      const { defineTool } = await loadDshTools();
      const tools = [
        defineTool({
          name: 'water_overview',
          description: '城市水资源综合态势总览：供水总量、用水负荷、水库蓄水率、今日预警、未来72小时供需预测与风险指数。数据为演示数据（source=demo），正式决策前需核验实时监测。',
          parameters: {
            city: { type: 'string', description: `城市名（${CITIES.join('/')}），默认青岛市` },
          },
          output: {
            schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.text }],
          },
          isConcurrencySafe: () => true,
          async execute(args) { return { text: overviewSummary(args.city) }; },
        }),
        defineTool({
          name: 'water_risk',
          description: '查询城市水资源风险与预警清单（洪涝/供水/水质/管网），含处置闭环状态。数据为演示数据（source=demo）。',
          parameters: {
            city: { type: 'string', description: `城市名（${CITIES.join('/')}），默认青岛市` },
            scope: { type: 'string', description: '风险范围：all / 洪涝 / 供水 / 水质 / 管网，默认 all' },
          },
          output: {
            schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.text }],
          },
          isConcurrencySafe: () => true,
          async execute(args) { return { text: riskSummary(args.city, args.scope ?? 'all') }; },
        }),
        defineTool({
          name: 'water_report_draft',
          description: '生成城市水务报告草稿（日报/专报/复盘）：运行摘要、供需预测、风险清单、调度建议与依据引用。草稿基于演示数据，需人工审核与审批后发布。',
          parameters: {
            kind: { type: 'string', description: '报告类型：日报 / 专报 / 复盘，默认日报' },
            city: { type: 'string', description: `城市名（${CITIES.join('/')}），默认青岛市` },
          },
          output: {
            schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.text }],
          },
          isConcurrencySafe: () => true,
          async execute(args) { return { text: reportDraft(args.kind ?? '日报', args.city) }; },
        }),
      ];
      for (const tool of tools) disposers.push(ctx.tools.register(tool));
      log(`已注册 ${tools.length} 个只读演示工具（water_overview / water_risk / water_report_draft）`);
    } catch (error) {
      log(`工具注册跳过（dsh-tools 不可用，仅降级、不影响界面）：${error?.message ?? error}`);
    }

    log(`城市水智管插件就绪：${BASE}/workbench/（loopback-only，演示数据模式）`);

    return () => {
      for (const dispose of disposers.splice(0)) {
        try { dispose(); } catch { /* ignore */ }
      }
    };
  }, 'dsh-city-water: workbench server + data api + tools');
}
