#!/usr/bin/env node
/**
 * 生成「加密短链」访问链接，供简历二维码使用。与宿主插件共用同一 .auth-secrets。
 *
 * 用法：
 *   # 1) 永久链接（默认，长期有效，推荐）：随机 32 位 hex 令牌，写入 .auth-secrets
 *   node scripts/gen-access-link.mjs --base https://water.yuxinqu.com
 *
 *   # 2) 限时链接（可选）：HMAC 签名 + 有效期
 *   node scripts/gen-access-link.mjs --days 30 --base https://water.yuxinqu.com
 *
 * 吊销永久链接：删除 .auth-secrets 中对应 LINK_TOKEN 行（或 env DSH_CITY_WATER_LINK_TOKENS），
 * 插件每次请求都会重读，无需重启（限时链接过期后自动失效）。
 */
import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_AUTH_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.auth-secrets');

function readSecret(key) {
  const env = process.env[`DSH_CITY_WATER_${key}`];
  if (env) return env;
  const file = process.env.DSH_CITY_WATER_AUTH_FILE || DEFAULT_AUTH_FILE;
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*([0-9a-fA-F]+)\\s*$`));
      if (m) return m[1];
    }
  }
  return null;
}

function parseArgs(argv) {
  const args = { days: null, base: 'https://water.yuxinqu.com' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--days') args.days = Number(argv[++i] || '30');
    else if (argv[i] === '--base') args.base = argv[++i] || args.base;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.days && args.days > 0) {
  // 限时模式：HMAC 签名，过期自动失效
  const secret = readSecret('LINK_SECRET');
  if (!secret) throw new Error('未找到 LINK_SECRET：请先运行一次插件以生成 .auth-secrets，或设置 DSH_CITY_WATER_LINK_SECRET');
  const expiresAtMs = Date.now() + args.days * 86400000;
  const nonce = randomBytes(12).toString('hex');
  const payload = `t.${expiresAtMs}.${nonce}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  const url = `${args.base}/go/${payload}.${sig}`;
  console.log(`限时访问链接（有效 ${args.days} 天，过期自动失效）：`);
  console.log(url);
  console.log('');
  console.log('二维码：用 https://cli.im 等工具将上面链接生成二维码。');
} else {
  // 永久模式（默认）：随机 32 位 hex 令牌，长期有效，写入 .auth-secrets
  const file = process.env.DSH_CITY_WATER_AUTH_FILE || DEFAULT_AUTH_FILE;
  const token = randomBytes(16).toString('hex'); // 32 位 hex，128bit 熵
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!new RegExp(`(^|\\n)LINK_TOKEN=${token}\\s*$`, 'm').test(existing)) {
    appendFileSync(file, `LINK_TOKEN=${token}\n`, { mode: 0o600 });
  }
  const url = `${args.base}/go/${token}`;
  console.log('永久访问链接（长期有效，已写入 .auth-secrets，无需重启即生效）：');
  console.log(url);
  console.log('');
  console.log(`令牌 token = ${token}`);
  console.log('');
  console.log('二维码：用 https://cli.im 等工具将上面链接生成二维码，图片命名 city-water-qr.png。');
  console.log(`吊销：删除 ${file} 中 LINK_TOKEN=${token} 行即可（插件请求时实时重读）。`);
}
