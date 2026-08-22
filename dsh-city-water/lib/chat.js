/**
 * dsh-city-water 面板内对话通道：/api/dsh-city-water/chat 的对话引擎。
 *
 * 两种模式（自动选择）：
 *  - live：配置了 DeepSeek API 时，真实模型 + 水务工具调用循环（流式 SSE 转发）
 *  - demo：无密钥时，按任务关键词返回基于演示数据的研判结论（模拟流式）
 *
 * 安全：本文件只做"生成方案与结论"，绝不触达生产系统；审批红线写进系统提示。
 *
 * @module dsh-city-water/lib/chat
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { overviewSummary, riskSummary, reportDraft, buildWaterData } from './water-data.js';

const MAX_ROUNDS = 4;
const HISTORY_LIMIT = 12;
const MAX_MESSAGE = 4000;

/** 水资源管理技能正文（与 DSH 原生 skill 单一事实源，见 skills/city-water/SKILL.md）。 */
const SKILL_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'city-water', 'SKILL.md');

function skillBody() {
  try {
    const raw = readFileSync(SKILL_PATH, 'utf8');
    const match = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(raw);
    return (match ? match[1] : raw).trim();
  } catch {
    return '';
  }
}

const SYSTEM_PROMPT = `你是「城市水智管 · 城市水资源管理 Agent」，支持正常的大模型对话，并在水资源场景挂载专业技能。
通用要求：
1. 正常回答用户的一般性问题（解释、总结、建议、日常咨询等），用简洁、专业、结构清晰的中文。
2. 当任务涉及城市水资源（供水、调度、预警、河湖、水质、报告、监测数据等）时，按下方的「city-water 技能」执行。
3. 区分实时事实、模型预测与建议，不虚构未提供的监测数据；回答注明数据时间范围与不确定性。
4. 审批红线：任何可能影响真实生产系统的操作（泵站、闸门、管网、SCADA）只生成方案，绝不声称已经下发，必须等待人工审批。
5. 可用工具：查询总体态势用 water_overview；查询风险与预警用 water_risk；起草报告用 water_report_draft。先查数据再下结论，引用工具返回的依据。

【技能 city-water】
${skillBody()}`;

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'water_overview',
      description: '城市水资源综合态势总览：供水总量、用水负荷、水库蓄水率、今日预警、未来72小时供需预测与风险指数。数据为演示数据（source=demo）。',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: '城市名（青岛市/济南市/烟台市），默认青岛市' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'water_risk',
      description: '查询城市水资源风险与预警清单（洪涝/供水/水质/管网），含处置闭环状态。数据为演示数据（source=demo）。',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名（青岛市/济南市/烟台市），默认青岛市' },
          scope: { type: 'string', description: '风险范围：all / 洪涝 / 供水 / 水质 / 管网，默认 all' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'water_report_draft',
      description: '生成城市水务报告草稿（日报/专报/复盘）：运行摘要、供需预测、风险清单、调度建议与依据引用。草稿需人工审核与审批后发布。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: '报告类型：日报 / 专报 / 复盘，默认日报' },
          city: { type: 'string', description: '城市名（青岛市/济南市/烟台市），默认青岛市' },
        },
      },
    },
  },
];

const TOOL_EXECUTORS = {
  water_overview: async (args) => overviewSummary(args.city),
  water_risk: async (args) => riskSummary(args.city, args.scope ?? 'all'),
  water_report_draft: async (args) => reportDraft(args.kind ?? '日报', args.city),
};

/** 校验并裁剪会话历史（只保留 user/assistant，最多 HISTORY_LIMIT 条）。 */
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-HISTORY_LIMIT)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE) }));
}

/** 解析一行 OpenAI SSE（去掉 "data:" 前缀）。 */
function sseDataOf(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return undefined;
  const payload = trimmed.slice(5).trim();
  if (payload === '[DONE]') return undefined;
  try { return JSON.parse(payload); } catch { return undefined; }
}

/**
 * live 模式：一轮流式 chat completions。
 * @returns {{ content: string, toolCalls: Array<{id,name,arguments}> , finish: string }}
 */
async function streamRound({ baseUrl, apiKey, model, messages, tools, onDelta, signal }) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', stream: true, temperature: 0.3 }),
    signal,
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try { detail = (await response.json()).error?.message || detail; } catch { /* ignore */ }
    throw new Error(`DeepSeek API 调用失败：${detail}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finish = '';
  const toolCalls = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const chunk = sseDataOf(line);
      if (chunk === undefined) continue;
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        content += delta.content;
        onDelta?.(delta.content);
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = call.index ?? 0;
          while (toolCalls.length <= index) toolCalls.push({ id: '', name: '', arguments: '' });
          const slot = toolCalls[index];
          if (call.id) slot.id = call.id;
          if (call.function?.name) slot.name += call.function.name;
          if (call.function?.arguments) slot.arguments += call.function.arguments;
        }
      }
      if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
    }
  }
  return { content, toolCalls: toolCalls.filter((t) => t.name !== ''), finish };
}

/** live 模式：带工具循环的完整对话。 */
async function runLive({ city, history, message, apiKey, baseUrl, model, onStatus, onDelta, signal }) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT + `\n当前工作城市：${city}。` },
    ...sanitizeHistory(history),
    { role: 'user', content: message },
  ];
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const { content, toolCalls, finish } = await streamRound({
      baseUrl, apiKey, model, messages, tools: TOOL_SCHEMAS, onDelta, signal,
    });
    if (toolCalls.length === 0 || finish !== 'tool_calls') {
      return { mode: 'live', content };
    }
    messages.push({ role: 'assistant', content: content || '', tool_calls: toolCalls.map((t) => ({
      id: t.id || `call_${round}_${toolCalls.indexOf(t)}`,
      type: 'function',
      function: { name: t.name, arguments: t.arguments || '{}' },
    })) });
    for (const call of toolCalls) {
      const args = (() => { try { return JSON.parse(call.arguments || '{}'); } catch { return {}; } })();
      onStatus?.({ step: 'tool', tool: call.name, args, phase: 'running' });
      const executor = TOOL_EXECUTORS[call.name];
      let resultText = `工具 ${call.name} 不可用`;
      if (executor !== undefined) {
        try { resultText = await executor(args); } catch (error) { resultText = `工具执行失败：${error?.message ?? error}`; }
      }
      onStatus?.({ step: 'tool', tool: call.name, args, phase: 'done', result: String(resultText).slice(0, 4000) });
      messages.push({ role: 'tool', tool_call_id: call.id || `call_${round}_${toolCalls.indexOf(call)}`, content: resultText });
    }
  }
  return { mode: 'live', content: '已完成多轮工具研判。请结合上方依据确认结论，必要时提出新的查询。' };
}

/** demo 模式：基于演示数据的关键词研判（无外部 API）；非水务问题按通用助手回答。 */
function demoAnswer(city, message) {
  const data = buildWaterData(city);
  if (/^(你好|您好|hi|hello|嗨|在吗|早上好|下午好|晚上好)/i.test(message.trim()) || /^(谢谢|感谢|辛苦了|再见)/.test(message.trim())) {
    return '你好，我是「城市水智管 · 城市水资源管理 Agent」。当前为演示模式（未配置 DeepSeek 密钥），可以就城市供水、调度、预警、河湖与报告等问题给出基于演示数据的研判；配置密钥后即支持完整的大模型通用对话。';
  }
  if (/你是谁|你能做什么|介绍一下/.test(message)) {
    return '我是城市水资源管理 Agent，支持正常对话与水资源专业技能（city-water 技能）：\n1. 态势研判：供水总量、用水负荷、水库蓄水率、72小时供需预测（water_overview）；\n2. 风险预警：洪涝 / 供水 / 水质 / 管网预警清单与处置闭环（water_risk）；\n3. 调度方案：安全优先 / 成本优先 / 韧性优先三档方案推演（只生成方案，人工审批后执行）；\n4. 报告编制：日报 / 专报 / 复盘草稿（water_report_draft）。\n当前为演示模式（source=demo），正式决策请核验实时数据。';
  }
  if (/洪|涝|雨/.test(message)) {
    return `${riskSummary(city, '洪涝')}\n\n研判结论（风险等级：高）：未来6小时东部沿海需关注短时强降雨，李村河下游及2处下穿通道为重点区域。建议提前布防排水单元、降低泵站启排水位，并由值班人员确认后执行。当前为演示数据，正式决策前请核验实时雨情。`;
  }
  if (/水质|污染/.test(message)) {
    return `${riskSummary(city, '水质')}\n\n研判结论（风险等级：低）：异常主要集中在白沙河2号断面，浊度上升与上游施工时段存在相关性，暂未发现饮用水源地联动风险。建议加密采样、复核传感器并通知属地巡查。当前为演示数据。`;
  }
  if (/报告|简报/.test(message)) {
    return `${reportDraft('日报', city)}\n\n说明：报告草稿已生成，包含运行摘要、供需预测、风险清单、调度建议与依据引用，可在报告中心继续审核。当前为演示模式。`;
  }
  if (/调度|方案|供水/.test(message)) {
    return `${overviewSummary(city)}\n\n研判结论：未来72小时全市供水总体可控，北部片区晚高峰存在约${data.forecast.gap}万m³缺口。建议崂山水库日增供3.0万m³、棘洪滩水库增供2.2万m³，并将城阳—市北联络线压力提高0.03MPa；所有生产参数须经调度人员审批后下发。当前结论基于演示态势数据。`;
  }
  if (/预警|风险|河湖/.test(message)) {
    return `${riskSummary(city, 'all')}\n\n研判结论：在办预警3项，其中洪涝1项橙色、供水与水质各1项黄色；处置闭环处于「人工签收」环节。建议优先处置橙色预警并跟踪闭环。当前为演示数据。`;
  }
  return `${overviewSummary(city)}\n\n综合研判：未来72小时全市供水总体可控，重点跟踪洪涝指数（当前较高）与北部片区晚高峰缺口。如需具体建议，可进一步指定「调度方案」「风险预警」或「生成报告」。当前结论基于演示态势数据。`;
}

/**
 * 面板对话入口。
 * @param {object} options
 * @param {string} options.city 当前工作城市
 * @param {string} options.message 本轮任务
 * @param {Array} [options.history] 会话历史（近 N 条）
 * @param {string} [options.apiKey] DeepSeek 密钥；缺省走 demo 模式
 * @param {string} [options.baseUrl] API 基址
 * @param {string} [options.model] 模型名
 * @param {(e:{step:'tool',tool:string,phase:'running'|'done',result?:string})=>void} [options.onStatus]
 * @param {(text:string)=>void} [options.onDelta]
 * @param {AbortSignal} [options.signal]
 */
export async function runChat(options) {
  const { city = '青岛市', message, apiKey, baseUrl = 'https://api.deepseek.com', model = 'deepseek-chat' } = options;
  if (apiKey) {
    return runLive({ ...options, apiKey, baseUrl: String(baseUrl).replace(/\/$/, ''), model });
  }
  // 演示模式：模拟流式，体验与 live 一致。
  const answer = demoAnswer(city, message);
  const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  for (const chunk of answer.match(/[\s\S]{1,24}/g) ?? [answer]) {
    if (options.signal?.aborted) break;
    options.onDelta?.(chunk);
    await delay(24);
  }
  return { mode: 'demo', content: answer };
}
