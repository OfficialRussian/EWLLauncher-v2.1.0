'use strict';
/**
 * Диагностика одним файлом: .zip с логами лаунчера и игры, последним отчётом о вылете и сведениями о системе.
 * Перед сохранением из текстов вырезаются токены, ключи, e-mail и имя пользователя Windows — файл безопасно
 * отправлять в поддержку или выкладывать на GitHub.
 */
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const MAX_LINES = 1500;

function redact(text) {
  return String(text)
    .replace(/[A-Za-z]:\\Users\\[^\\/\s"'<>|]+/g, 'C:\\Users\\<user>')
    .replace(/\/(home|Users)\/[^/\s"'<>|]+/g, '/$1/<user>')
    .replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/g, '<token>')
    .replace(/\$2[aby]\$\d\d\$[A-Za-z0-9./]{40,}/g, '<key>')
    .replace(/token:[^\s:]+:[0-9a-fA-F-]{32,36}/g, 'token:<hidden>')
    .replace(/(--(?:accessToken|session|uuid|xuid|clientId)\s+)\S+/gi, '$1<hidden>')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>');
}

const tailLines = (text, n) => { const l = String(text).split(/\r?\n/); return l.slice(-n).join('\n'); };

async function readSafe(file, maxBytes = 4 * 1024 * 1024) {
  try {
    const st = await fsp.stat(file);
    const fh = await fsp.open(file, 'r');
    try {
      const len = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, st.size - len);
      return buf.toString('utf8');
    } finally { await fh.close(); }
  } catch (_) { return null; }
}

async function newest(dir, re) {
  let names = [];
  try { names = await fsp.readdir(dir); } catch (_) { return null; }
  let best = null;
  for (const n of names) {
    if (!re.test(n)) continue;
    try { const st = await fsp.stat(path.join(dir, n)); if (!best || st.mtimeMs > best.m) best = { file: path.join(dir, n), name: n, m: st.mtimeMs }; } catch (_) { /* исчез */ }
  }
  return best;
}

/** Настройки без секретов и личных данных. */
function safeSettings(s) {
  const out = { ...s };
  for (const k of ['curseforgeKey', 'msClientId', 'javaPath', 'gameDir', 'updateRepo']) if (out[k]) out[k] = '<скрыто>';
  delete out.serverList; delete out.profileNames;
  return out;
}

/**
 * Собирает архив и возвращает Buffer. ctx: { appVersion, settings, gameDir, userDataDir, logFile, versions, javas }
 */
async function build(ctx) {
  const zip = new AdmZip();
  const add = (name, text) => zip.addFile(name, Buffer.from(redact(text), 'utf8'));
  const info = [
    `EWLLauncher ${ctx.appVersion}`,
    `Время: ${new Date().toISOString()}`,
    `ОС: ${os.type()} ${os.release()} (${process.arch})`,
    `Electron: ${process.versions.electron || '—'}, Node: ${process.versions.node}`,
    `Память: ${Math.round(os.totalmem() / 1048576)} МБ всего, ${Math.round(os.freemem() / 1048576)} МБ свободно`,
    `Процессор: ${(os.cpus()[0] || {}).model || '—'} × ${os.cpus().length}`,
    '',
    'Установленные версии:',
    ...(ctx.versions || []).map((v) => `  ${v.id}${v.loader ? ` [${v.loader}]` : ''} (Minecraft ${v.mc})`),
    '',
    'Найденные Java:',
    ...((ctx.javas || []).map((j) => `  Java ${j.major} — ${j.path}`)),
    '',
    'Настройки (без секретов):',
    JSON.stringify(safeSettings(ctx.settings || {}), null, 2),
  ].join('\n');
  add('info.txt', info);

  const launcher = ctx.logFile ? await readSafe(ctx.logFile) : null;
  if (launcher) add('launcher.log', tailLines(launcher, MAX_LINES));

  const dirs = [{ id: '', dir: ctx.gameDir }];
  try {
    for (const n of await fsp.readdir(path.join(ctx.gameDir, 'instances'))) dirs.push({ id: n, dir: path.join(ctx.gameDir, 'instances', n) });
  } catch (_) { /* профилей нет */ }
  // последний лог игры, отчёт о вылете и hs_err — из самой свежей папки
  let latest = null;
  for (const d of dirs) {
    const f = await newest(path.join(d.dir, 'logs'), /^latest\.log$/);
    if (f && (!latest || f.m > latest.m)) latest = { ...f, id: d.id };
  }
  if (latest) { const t = await readSafe(latest.file); if (t) add('game-latest.log', tailLines(t, MAX_LINES)); }
  let crash = null; let hs = null;
  for (const d of dirs) {
    const c = await newest(path.join(d.dir, 'crash-reports'), /^crash-.*\.txt$/i);
    if (c && (!crash || c.m > crash.m)) crash = c;
    const h = await newest(d.dir, /^hs_err_pid\d+\.log$/i);
    if (h && (!hs || h.m > hs.m)) hs = h;
  }
  if (crash) { const t = await readSafe(crash.file, 256 * 1024); if (t) add(`crash-report/${crash.name}`, t); }
  if (hs) { const t = await readSafe(hs.file, 128 * 1024); if (t) add(`hs_err/${hs.name}`, t); }
  return zip.toBuffer();
}

module.exports = { build, redact, safeSettings };
