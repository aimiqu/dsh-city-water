#!/usr/bin/env node
/**
 * 生成「加密短链」访问链接（HMAC 签名 + 限时），供简历二维码使用。
 * 与宿主插件共用同一 LINK_SECRET（env 或 .auth-secrets 文件）。
 *
 * 用法：
 *   node scripts/gen-access-link.mjs [--days 30] [--base https://water.yuxinqu.com]
 *   DSH_CITY_WATER_LINK_SECRET=xxx node scripts/gen-access-link.mjs
 */
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_AUTH_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.auth-secrets');

function loadSecret() {
  const env = process.env.DSH_CITY_WATER_LINK_SECRET;
  if (env) return env;
  const file = process.env.DSH_CITY_WATER_AUTH_FILE || DEFAULT_AUTH_FILE;
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*LINK_SECRET\s*=\s*([0-9a-fA-F]+)\s*$/);
      if (m) return m[1];
    }
  }
  throw new Error('未找到 LINK_SECRET：请设置 DSH_CITY_WATER_LINK_SECRET，或先运行一次插件以自动生成 ' + DEFAULT_AUTH_FILE);
}

function parseArgs(argv) {
  const args = { days: 30, base: 'https://water.yuxinqu.com' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--days') args.days = Number(argv[++i] || '30');
    else if (argv[i] === '--base') args.base = argv[++i] || args.base;
  }
  if (!Number.isFinite(args.days) || args.days < 1) args.days = 30;
  return args;
}

const args = parseArgs(process.argv.slice(2));
const secret = loadSecret();
const expiresAtMs = Date.now() + args.days * 86400000;
const nonce = randomBytes(12).toString('hex');
const payload = `t.${expiresAtMs}.${nonce}`;
const sig = createHmac('sha256', secret).update(payload).digest('hex');
const token = `${payload}.${sig}`;
const url = `${args.base}/go/${token}`;

console.log(`访问链接（有效 ${args.days} 天，扫码即免密进入工作台）：`);
console.log(url);
console.log('');
console.log('二维码：用 https://cli.im 等工具将上面链接生成二维码，图片命名 city-water-qr.png。');
