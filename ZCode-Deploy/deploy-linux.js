#!/usr/bin/env node
// ============================================
// ZCode 人格部署工具 — Ubuntu / Linux 版
//
// 适配来源: deploy.ps1 (Windows / PowerShell 5.1)
// 目标: 本地 Linux ZCode 3.17.2 (resources/glm/zcode.cjs)
//
// 与 Windows v2 六补丁不同，这里只做两个补丁：
//   1. CLI Prefix 里的产品身份声明置空
//   2. ContextBuilder.build() 的 customSystemPrompt 改为读取人格.txt
// 不把 Current Date / Skills / Request User Context 三个片段函数改成
// `return null;`。本机 ZCode 3.17.2 在恢复会话时会读取这些片段结构，
// 全部置空会导致 `Cannot read properties of null (reading 'length')`，
// 界面显示「初始化失败，暂时无法发送」。
//
// customSystemPrompt 有值时，ZCode 自己会跳过 System Context /
// Environment Info / Memory / Agent Identity 等大部分注入，因此仍能把
// 人格文件作为主要 system 内容；同时保留会话初始化所需的片段结构。
//
// 用法:
//   node deploy-linux.js install
//   node deploy-linux.js restore
//   node deploy-linux.js status
//   node deploy-linux.js diag
//   node deploy-linux.js verify
//
// 可识别环境变量:
//   ZCODE_DIR      ZCode 安装目录（默认自动探测 /opt/ZCode 等）
//   ZCODE_CJS      直接指定 zcode.cjs 路径
//   ZCODE_PERSONA  直接指定人格文件（默认脚本同目录 人格.txt）
//   SUDO_PASSWORD  仅在需要 root 写入安装包时使用（也可交互式 sudo）
//
// 注意:
//   - 修改 /opt 下的安装文件通常需要 sudo；脚本会保留原文件权限、属主。
//   - install / restore 前都会把当前 zcode.cjs 归档到 backups/。
//   - ZCode 更新或项目目录移动后，重新执行 install。
// ============================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const DEFAULT_CJS = '/opt/ZCode/resources/glm/zcode.cjs';
const DEFAULT_BACKUP = DEFAULT_CJS + '.bak';
const BACKUP_DIR = path.join(SCRIPT_DIR, 'backups');
const DEFAULT_PERSONA = path.join(SCRIPT_DIR, '人格.txt');
const MARKER = 'ZP:PERSONA';

// 本机 3.17.2 bundle 里的稳定锚点（可能与旧版 Windows bundle 不同）
const IDENTITY_LIT = '"You are ZCode, an interactive agent"';
const CUSTOM_PROMPT_RE = /([A-Za-z_$][\w$]*)=this\.config\.customSystemPrompt,([A-Za-z_$][\w$]*)=!!\1\?\.trim\(\),/;
// 兼容另一代 bundle 的 customSystemPrompt 写法
const CUSTOM_PROMPT_RE_ALT = /([A-Za-z_$][\w$]*)=this\.config\.customSystemPrompt\?\.trim\(\),([A-Za-z_$][\w$]*)=!!\1,/;

const SECTIONS_RE = /name:"([^"]{1,64})",source:"([^"]{1,64})",injectionTarget:"([^"]{1,32})"/g;

function info(m) { console.log('\x1b[36m' + m + '\x1b[0m'); }
function good(m) { console.log('  \x1b[32m[OK]\x1b[0m ' + m); }
function skip(m) { console.log('  \x1b[90m[跳过]\x1b[0m ' + m); }
function warn(m) { console.log('  \x1b[33m[警告]\x1b[0m ' + m); }
function bad(m) { console.error('  \x1b[31m[失败]\x1b[0m ' + m); }
function note(m) { console.log('  ' + m); }

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function findZcodeDir() {
  if (process.env.ZCODE_DIR) return process.env.ZCODE_DIR;
  const candidates = [
    '/opt/ZCode',
    '/usr/lib/ZCode',
    '/usr/share/ZCode',
    path.join(os.homedir(), '.local/share/ZCode'),
    path.join(os.homedir(), '.local/opt/ZCode'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'resources/glm/zcode.cjs'))) return dir;
  }
  return null;
}

function resolveCjs() {
  if (process.env.ZCODE_CJS) return process.env.ZCODE_CJS;
  const dir = findZcodeDir();
  if (dir) return path.join(dir, 'resources/glm/zcode.cjs');
  return DEFAULT_CJS;
}

function resolvePersona() {
  return process.env.ZCODE_PERSONA || DEFAULT_PERSONA;
}

function personaExpr(personaPath) {
  const js = personaPath.replace(/\\/g, '/').replace(/"/g, '\\"');
  return '(function(){/*' + MARKER + '*/try{return require("fs").readFileSync("' + js + '","utf8")}catch(e){return null}})()';
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function patchCliPrefix(c) {
  if (!c.includes(IDENTITY_LIT)) return { status: 'skip', content: c, name: '' };
  const re = new RegExp('([A-Za-z_$][\\w$]*)=' + escapeRegExp(IDENTITY_LIT));
  const m = c.match(re);
  if (!m) return { status: 'missing', content: c, name: '' };
  const rep = m[1] + '=""';
  return {
    status: 'ok',
    content: c.slice(0, m.index) + rep + c.slice(m.index + m[0].length),
    name: m[1],
  };
}

function patchCustomPrompt(c, expr) {
  let m = c.match(CUSTOM_PROMPT_RE);
  let alt = false;
  if (!m) {
    m = c.match(CUSTOM_PROMPT_RE_ALT);
    alt = true;
  }
  if (!m) {
    return c.includes(MARKER)
      ? { status: 'skip', content: c, name: '' }
      : { status: 'missing', content: c, name: '' };
  }
  const v = m[1], f = m[2];
  const rep = alt
    ? v + '=' + expr + '?.trim(),' + f + '=!!' + v + ','
    : v + '=' + expr + ',' + f + '=!!' + v + '?.trim(),';
  return {
    status: 'ok',
    content: c.slice(0, m.index) + rep + c.slice(m.index + m[0].length),
    name: v,
  };
}

function makePatched(content, personaPath) {
  const results = [];
  let r = patchCliPrefix(content);
  results.push({ id: 1, label: 'CLI Prefix 身份声明置空', ...r });
  content = r.content;

  r = patchCustomPrompt(content, personaExpr(personaPath));
  results.push({ id: 2, label: 'customSystemPrompt 读人格文件', ...r });
  content = r.content;

  return { content, results };
}

function staticReport(content, personaPath) {
  return [
    ['CLI Prefix 身份声明已清空', !content.includes(IDENTITY_LIT)],
    ['customSystemPrompt 读人格文件', content.includes(MARKER)],
    ['人格路径指向当前项目', content.includes(personaPath.replace(/\\/g, '/'))],
    ['未使用破坏初始化的 return null 补丁', !/\{return null;/.test(content.slice(content.indexOf('name:"Current Date"') - 500, content.indexOf('name:"Current Date"') + 500))],
  ];
}

function braceClose(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function findFunctionForLiteral(content, literal) {
  const idx = content.indexOf(literal);
  if (idx < 0) return null;
  const start = Math.max(0, idx - 30000);
  const head = content.slice(start, idx);
  const re = /function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g;
  let best = null, m;
  while ((m = re.exec(head)) !== null) {
    const open = start + m.index + m[0].length - 1;
    if (braceClose(content, open) > idx) best = { name: m[1], open };
  }
  return best;
}

function syntaxCheck(content) {
  const tmp = path.join(os.tmpdir(), 'zcode-syntax-' + crypto.randomBytes(6).toString('hex') + '.cjs');
  try {
    fs.writeFileSync(tmp, content);
    const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    if (r.status === 0) return { ok: true, output: '' };
    return { ok: false, output: ((r.stderr || '') + (r.stdout || '')).trim() };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function archiveCurrent(cjs, kind) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dest = path.join(BACKUP_DIR, `zcode.cjs.${kind}-linux-${stamp}.bak`);
  fs.copyFileSync(cjs, dest);
  const backups = fs.readdirSync(BACKUP_DIR)
    .filter(n => n.endsWith('.bak'))
    .map(n => ({ n, t: fs.statSync(path.join(BACKUP_DIR, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const b of backups.slice(7)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, b.n)); } catch {}
  }
  return dest;
}

function readFileStat(p) {
  const st = fs.statSync(p);
  return { size: st.size, mtime: st.mtime.toISOString(), mode: st.mode & 0o7777, uid: st.uid, gid: st.gid };
}

function ensureWritable(cjs) {
  if (!fs.existsSync(cjs)) throw new Error('目标文件不存在: ' + cjs);
  try {
    fs.accessSync(cjs, fs.constants.W_OK);
    return false; // no sudo needed
  } catch (e) {
    return true;
  }
}

function shellQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function sudoWrite(sourceFile, targetFile, meta) {
  const password = process.env.SUDO_PASSWORD;
  const chown = meta ? `chown ${meta.uid}:${meta.gid} ${shellQuote(targetFile)}` : '';
  const chmod = meta ? `chmod ${meta.mode.toString(8)} ${shellQuote(targetFile)}` : '';
  const script = `cp ${shellQuote(sourceFile)} ${shellQuote(targetFile)}\n${chown}\n${chmod}\n`;
  const args = password
    ? ['-S', 'sh', '-c', script]
    : ['sh', '-c', script];
  const r = spawnSync('sudo', args, {
    input: password ? password + '\n' : undefined,
    stdio: password ? ['pipe', 'inherit', 'inherit'] : ['inherit', 'inherit', 'inherit'],
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error('sudo 写入失败（exit ' + r.status + '）');
}

function writePatched(cjs, content) {
  const meta = readFileStat(cjs);
  const tmp = path.join(os.tmpdir(), 'zcode-patched-' + crypto.randomBytes(6).toString('hex') + '.cjs');
  fs.writeFileSync(tmp, content);
  try {
    if (ensureWritable(cjs)) {
      note('安装目录需要 root 权限，正在通过 sudo 写入…');
      sudoWrite(tmp, cjs, meta);
    } else {
      fs.writeFileSync(cjs, content);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function readPersona(personaPath) {
  if (!fs.existsSync(personaPath)) throw new Error('人格文件不存在: ' + personaPath);
  return fs.readFileSync(personaPath, 'utf8');
}

function executeReader(content) {
  const start = content.indexOf('(function(){/*' + MARKER + '*/');
  if (start < 0) return null;
  const end = content.indexOf('})()', start);
  if (end < 0) return null;
  const expr = content.slice(start, end + 4);
  try {
    return new Function('require', 'return (' + expr + ');')(require);
  } catch (e) {
    return null;
  }
}

function actionStatus(cjs, personaPath) {
  info('=== ZCode Ubuntu 部署状态 ===');
  if (!fs.existsSync(cjs)) { bad('目标文件不存在: ' + cjs); process.exit(1); }
  const content = fs.readFileSync(cjs, 'utf8');
  const meta = readFileStat(cjs);
  note('目标文件:   ' + cjs);
  note('文件大小:   ' + meta.size + ' bytes');
  note('修改时间:   ' + meta.mtime);
  note('人格文件:   ' + (fs.existsSync(personaPath) ? fs.statSync(personaPath).size + ' bytes' : '缺失'));
  note('原版备份:   ' + (fs.existsSync(cjs + '.bak') ? fs.statSync(cjs + '.bak').size + ' bytes' : '无'));
  console.log('');
  console.log(content.includes(MARKER) ? '\x1b[33m模式: 自定义人格 (Linux 适配版已部署)\x1b[0m' : '\x1b[32m模式: ZCode 原版 (未部署)\x1b[0m');
  console.log('');
  info('--- 补丁校验 ---');
  for (const [name, ok] of staticReport(content, personaPath)) {
    if (ok) good(name); else warn(name);
  }
}

function actionDiag(cjs) {
  info('=== 注入片段定位 (诊断) ===');
  if (!fs.existsSync(cjs)) { bad('目标文件不存在: ' + cjs); process.exit(1); }
  const content = fs.readFileSync(cjs, 'utf8');
  note('文件: ' + cjs + ' (' + content.length + ' chars)');
  note('已部署: ' + content.includes(MARKER));
  console.log('');
  let i = 0, m;
  SECTIONS_RE.lastIndex = 0;
  while ((m = SECTIONS_RE.exec(content)) !== null) {
    i++;
    const fn = findFunctionForLiteral(content, m[0]);
    note(String(i).padStart(2) + '. ' + m[1].padEnd(30) + ' source=' + m[2].padEnd(26) + ' target=' + m[3].padEnd(12) + ' fn=' + (fn ? fn.name : '?'));
  }
  if (i === 0) note('(未识别到任何注入片段)');
}

function actionVerify(cjs, personaPath) {
  info('=== 功能验证 ===');
  if (!fs.existsSync(cjs)) { bad('目标文件不存在: ' + cjs); process.exit(1); }
  const content = fs.readFileSync(cjs, 'utf8');
  let fail = 0;
  function check(label, ok, extra) {
    console.log((ok ? '  \x1b[32m[OK]\x1b[0m   ' : '  \x1b[31m[FAIL]\x1b[0m ') + label + (extra ? '   -> ' + extra : ''));
    if (!ok) fail++;
  }

  const persona = fs.existsSync(personaPath) ? fs.readFileSync(personaPath, 'utf8') : '';
  const markerCount = content.split(MARKER).length - 1;
  check('ZP:PERSONA 标记存在', markerCount >= 1, markerCount + ' 处');
  if (markerCount === 0) { console.log('\n结果: 未部署'); process.exit(1); }

  for (const [name, ok] of staticReport(content, personaPath)) check(name, ok);

  const readVal = executeReader(content);
  check('注入的读取表达式能读到人格文件', readVal === persona, readVal ? readVal.length + ' chars' : 'null');

  // 确认三个会触发初始化失败的片段仍是可执行函数体，而不是 {return null;
  const sections = [
    ['日期提醒', 'name:"Current Date",source:"current_date"'],
    ['Skills 列表', 'name:"Skills",source:"skills"'],
    ['User Context', 'name:"Request User Context",source:"request_user_context"'],
  ];
  for (const [label, literal] of sections) {
    const fn = findFunctionForLiteral(content, literal);
    check(label + ' 片段结构保留（未粗暴置空）', !!fn, fn ? fn.name : '未定位');
  }

  const syntax = syntaxCheck(content);
  check('node --check 语法校验', syntax.ok, syntax.output.slice(0, 200));

  console.log('');
  if (fail === 0) {
    console.log('结果: 全部通过 —— 人格入口已生效且会话初始化结构未被破坏');
  } else {
    console.log('结果: ' + fail + ' 项失败');
    process.exit(1);
  }
}

function actionInstall(cjs, personaPath) {
  info('[1/6] 检查人格文件…');
  const persona = readPersona(personaPath);
  good(personaPath + ' (' + Buffer.byteLength(persona) + ' bytes)');

  info('[2/6] 读取并归档当前 zcode.cjs…');
  if (!fs.existsSync(cjs)) { bad('目标文件不存在: ' + cjs); process.exit(1); }
  const original = fs.readFileSync(cjs, 'utf8');
  const arch = archiveCurrent(cjs, original.includes(MARKER) ? 'patched' : 'stock');
  note('已归档 -> ' + arch);

  // 只在原版且备份缺失/不一致时刷新 .bak，避免把补丁版写成 restore 源
  const bak = cjs + '.bak';
  if (!original.includes(MARKER)) {
    const bakBuf = fs.existsSync(bak) ? fs.readFileSync(bak) : null;
    const originalHash = sha256(Buffer.from(original));
    const bakHash = bakBuf ? sha256(bakBuf) : null;
    if (bakHash !== originalHash) {
      try {
        const parent = path.dirname(bak);
        const parentWritable = (() => {
          try { fs.accessSync(parent, fs.constants.W_OK); return true; } catch { return false; }
        })();
        if (!parentWritable) sudoWrite(cjs, bak, readFileStat(cjs));
        else fs.copyFileSync(cjs, bak);
        good('已刷新原版备份 ' + bak);
      } catch (e) {
        warn('刷新 .bak 失败: ' + e.message + '（安装仍继续）');
      }
    } else {
      skip('.bak 已是当前原版');
    }
  }

  info('[3/6] 应用 Linux 适配补丁…');
  const { content, results } = makePatched(original, personaPath);
  for (const r of results) {
    const tag = r.name ? ' (' + r.name + ')' : '';
    if (r.status === 'ok') good('[' + r.id + '] ' + r.label + tag);
    else if (r.status === 'skip') skip('[' + r.id + '] ' + r.label + tag);
    else bad('[' + r.id + '] ' + r.label + ' — 未找到目标');
  }
  if (results.some(r => r.status === 'missing')) {
    bad('有补丁未命中，ZCode 版本可能又变了。未做任何修改。');
    actionDiag(cjs);
    process.exit(1);
  }

  info('[4/6] 语法校验 (node --check)…');
  const syntax = syntaxCheck(content);
  if (!syntax.ok) {
    bad('补丁后语法校验失败，已放弃写入，原文件未被修改');
    note(syntax.output);
    process.exit(1);
  }
  good('语法校验通过');

  info('[5/6] 写入 zcode.cjs…');
  writePatched(cjs, content);
  good('已写入 ' + readFileStat(cjs).size + ' bytes');

  info('[6/6] 写入后自检…');
  for (const [name, ok] of staticReport(content, personaPath)) {
    if (ok) good(name); else warn(name);
  }
  note('人格文件路径(已写入 cjs): ' + personaPath);
  console.log('');
  console.log('\x1b[32m=== 部署完成 ===\x1b[0m');
  note('请手动重启 ZCode，并新建对话验证；旧会话可能仍显示旧状态。');
  note('ZCode 更新或本目录移动后，重新执行: node deploy-linux.js install');
}

function actionRestore(cjs) {
  info('[1/4] 检查原版备份…');
  const bak = cjs + '.bak';
  if (!fs.existsSync(bak)) {
    bad('备份不存在: ' + bak);
    if (fs.existsSync(BACKUP_DIR)) {
      note('backups/ 中可用档案:');
      for (const n of fs.readdirSync(BACKUP_DIR).filter(x => x.endsWith('.bak')).slice(0, 10)) note('  ' + n);
    }
    process.exit(1);
  }
  const content = fs.readFileSync(bak, 'utf8');
  good(bak + ' (' + fs.statSync(bak).size + ' bytes)');

  info('[2/4] 校验备份并归档当前版本…');
  const syntax = syntaxCheck(content);
  if (!syntax.ok) { bad('备份语法校验失败，已中止还原'); note(syntax.output); process.exit(1); }
  if (fs.existsSync(cjs)) {
    const cur = fs.readFileSync(cjs, 'utf8');
    if (cur.includes(MARKER)) archiveCurrent(cjs, 'patched');
  }

  info('[3/4] 还原代码…');
  writePatched(cjs, content);
  good('已还原为原版');

  info('[4/4] 完成…');
  note('请手动重启 ZCode；人格文件会保留。');
  console.log('\n\x1b[32m=== 恢复完成 ===\x1b[0m');
}

function main() {
  const action = (process.argv[2] || 'status').toLowerCase();
  const cjs = resolveCjs();
  const personaPath = resolvePersona();

  switch (action) {
    case 'status': actionStatus(cjs, personaPath); break;
    case 'diag': actionDiag(cjs); break;
    case 'verify': actionVerify(cjs, personaPath); break;
    case 'install': actionInstall(cjs, personaPath); break;
    case 'restore': actionRestore(cjs); break;
    case 'help':
    default:
      info('ZCode 人格部署工具 — Ubuntu / Linux 版');
      console.log('');
      note('用法: node deploy-linux.js <install|restore|status|diag|verify|help>');
      console.log('');
      note('环境变量: ZCODE_DIR / ZCODE_CJS / ZCODE_PERSONA / SUDO_PASSWORD');
      note('目标文件: ' + cjs);
      note('人格文件: ' + personaPath);
      break;
  }
}

main();
