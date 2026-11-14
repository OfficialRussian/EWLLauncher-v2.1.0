'use strict';
/**
 * Менеджер модов: чтение метаданных из jar (Fabric, Quilt, Forge, NeoForge, старый Forge), включение/выключение модов
 * (переименование .jar <-> .jar.disabled) и поиск типичных проблем: чужой загрузчик, не та версия Minecraft,
 * дубликаты, не хватает обязательных модов. Ничего не удаляет и не меняет без команды пользователя.
 */
const fsp = require('fs').promises;
const path = require('path');
const AdmZip = require('adm-zip');
const { gamePaths } = require('../core/paths');
const { describe } = require('../minecraft/loaders');

const MAX_JAR = 200 * 1024 * 1024; // больше — это не мод, а архив с чем-то другим
const BUILTIN = new Set(['minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'quilt-loader', 'forge', 'neoforge', 'fml', 'javafml', 'lowcodefml', 'mclanguage', 'quilted_fabric_api']);
const ACCEPTS = {
  fabric: ['fabric'], quilt: ['fabric', 'quilt'], forge: ['forge', 'legacy-forge'], neoforge: ['neoforge'],
};
const LOADER_NAMES = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge', 'legacy-forge': 'Forge (старый)' };

// ---------- версии ----------

const parseVer = (s) => String(s).replace(/^[^\d]*/, '').split(/[.\-+_]/).map((x) => (/^\d+$/.test(x) ? Number(x) : 0));
function cmp(a, b) {
  const pa = parseVer(a); const pb = parseVer(b);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

/** Совпадает ли версия Minecraft с ограничением Fabric/Quilt (">=1.20 <1.21", "1.20.x", "~1.20.1", "^1.20", "*") или maven-диапазоном Forge ("[1.20,1.21)"). true | false | null (не удалось понять). */
function mcMatches(constraint, mc) {
  if (constraint == null) return null;
  if (Array.isArray(constraint)) {
    const r = constraint.map((c) => mcMatches(c, mc));
    return r.includes(true) ? true : r.includes(null) ? null : false;
  }
  const c = String(constraint).trim();
  if (!c || c === '*') return true;
  const mavenRange = /^[\[(]\s*([^,\])]*)\s*,\s*([^,\])]*)\s*[\])]$/.exec(c);
  if (mavenRange) {
    const lo = mavenRange[1]; const hi = mavenRange[2];
    const loIncl = c[0] === '['; const hiIncl = c.endsWith(']');
    if (lo && (loIncl ? cmp(mc, lo) < 0 : cmp(mc, lo) <= 0)) return false;
    if (hi && (hiIncl ? cmp(mc, hi) > 0 : cmp(mc, hi) >= 0)) return false;
    return true;
  }
  if (/^\[[^,\]]+\]$/.test(c)) return cmp(mc, c.slice(1, -1)) === 0;
  for (const alt of c.split('||')) {
    let ok = true; let understood = false;
    for (const part of alt.trim().split(/\s+/)) {
      const m = /^(>=|<=|>|<|=|~|\^)?\s*([0-9][\w.\-+*xX]*)$/.exec(part);
      if (!m) { ok = null; break; }
      understood = true;
      const op = m[1] || '='; const v = m[2];
      if (/[xX*]/.test(v)) {
        const pre = v.split('.').filter((x) => !/^[xX*]$/.test(x)).join('.');
        if (!(mc === pre || mc.startsWith(`${pre}.`))) ok = false;
      } else if (op === '>=') { if (cmp(mc, v) < 0) ok = false; }
      else if (op === '>') { if (cmp(mc, v) <= 0) ok = false; }
      else if (op === '<=') { if (cmp(mc, v) > 0) ok = false; }
      else if (op === '<') { if (cmp(mc, v) >= 0) ok = false; }
      else if (op === '~') { const p = parseVer(v); const q = parseVer(mc); if (cmp(mc, v) < 0 || q[0] !== p[0] || q[1] !== p[1]) ok = false; }
      else if (op === '^') { const p = parseVer(v); const q = parseVer(mc); if (cmp(mc, v) < 0 || q[0] !== p[0]) ok = false; }
      else if (cmp(mc, v) !== 0 && mc !== v) ok = false;
    }
    if (ok === true && understood) return true;
    if (ok === null) return null;
  }
  return false;
}

// ---------- чтение метаданных ----------

/** Достаём значения из TOML-файла Forge/NeoForge без полного парсера: нужны только modId, version, displayName и зависимости. */
function parseModsToml(text) {
  const out = { id: '', name: '', version: '', depends: [] };
  const first = (re) => { const m = re.exec(text); return m ? m[1] : ''; };
  out.id = first(/^\s*modId\s*=\s*["']([^"']+)["']/m);
  out.name = first(/^\s*displayName\s*=\s*["']([^"']+)["']/m);
  out.version = first(/^\s*version\s*=\s*["']([^"']+)["']/m);
  // блоки [[dependencies.<id>]]: modId, mandatory/type, versionRange
  const re = /\[\[dependencies\.[^\]]+\]\]([\s\S]*?)(?=\n\s*\[\[|\n\s*\[[^\[]|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const b = m[1];
    const id = (/modId\s*=\s*["']([^"']+)["']/.exec(b) || [])[1];
    const range = (/versionRange\s*=\s*["']([^"']+)["']/.exec(b) || [])[1];
    const mandatory = /mandatory\s*=\s*true/i.test(b) || /type\s*=\s*["']required["']/i.test(b);
    if (id) out.depends.push({ id, range, mandatory });
  }
  return out;
}

/** Метаданные одного jar. Никогда не бросает: нечитаемый файл возвращается как { loader: 'unknown' }. */
function readJarInfo(file) {
  let zip;
  try { zip = new AdmZip(file); } catch (_) { return { loader: 'broken' }; }
  const read = (name) => { const e = zip.getEntry(name); return e ? e.getData().toString('utf8') : null; };
  try {
    const fab = read('fabric.mod.json');
    if (fab) {
      const j = JSON.parse(fab);
      const dep = j.depends || {};
      return {
        loader: 'fabric', id: j.id, name: j.name || j.id, version: j.version, provides: j.provides || [],
        mc: dep.minecraft == null ? null : dep.minecraft,
        depends: Object.entries(dep).filter(([k]) => !BUILTIN.has(k)).map(([id, range]) => ({ id, range, mandatory: true })),
      };
    }
    const q = read('quilt.mod.json');
    if (q) {
      const j = JSON.parse(q).quilt_loader || {};
      const deps = (j.depends || []).map((d) => (typeof d === 'string' ? { id: d } : { id: d.id, range: d.versions, optional: d.optional }));
      const mcDep = deps.find((d) => d.id === 'minecraft');
      return {
        loader: 'quilt', id: j.id, name: (j.metadata && j.metadata.name) || j.id, version: j.version,
        provides: (j.provides || []).map((p) => (typeof p === 'string' ? p : p.id)),
        mc: mcDep ? mcDep.range || null : null,
        depends: deps.filter((d) => !BUILTIN.has(d.id) && !d.optional).map((d) => ({ id: d.id, range: d.range, mandatory: true })),
      };
    }
    const neo = read('META-INF/neoforge.mods.toml');
    const frg = neo ? null : read('META-INF/mods.toml');
    const toml = neo || frg;
    if (toml) {
      const t = parseModsToml(toml);
      const mcDep = t.depends.find((d) => d.id === 'minecraft');
      return {
        loader: neo ? 'neoforge' : 'forge', id: t.id, name: t.name || t.id, version: t.version, provides: [],
        mc: mcDep ? mcDep.range || null : null,
        depends: t.depends.filter((d) => !BUILTIN.has(d.id) && d.mandatory),
      };
    }
    const legacy = read('mcmod.info');
    if (legacy) {
      let j = JSON.parse(legacy);
      if (j && j.modList) j = j.modList;
      const e = Array.isArray(j) ? j[0] : j;
      return { loader: 'legacy-forge', id: e && e.modid, name: (e && e.name) || (e && e.modid), version: e && e.version, mc: e && e.mcversion ? String(e.mcversion) : null, depends: [] };
    }
  } catch (_) { return { loader: 'unknown' }; }
  return { loader: 'unknown' };
}

// ---------- сканирование и включение/выключение ----------

const modsDir = (root, id) => path.join(gamePaths(root).instance(id), 'mods');
const isModFile = (n) => /\.jar(\.disabled)?$/i.test(n);

/** Список модов с метаданными и найденными проблемами. */
async function scan({ root, versionId }) {
  const d = await describe(root, versionId);
  const dir = modsDir(root, versionId);
  let names = [];
  try { names = (await fsp.readdir(dir)).filter(isModFile); } catch (_) { return { kind: d.kind, mc: d.mc, mods: [], problems: [] }; }
  const mods = [];
  for (const n of names.sort()) {
    const full = path.join(dir, n);
    let size = 0;
    try { size = (await fsp.stat(full)).size; } catch (_) { continue; }
    const enabled = !/\.disabled$/i.test(n);
    const info = size > MAX_JAR ? { loader: 'unknown' } : readJarInfo(full);
    mods.push({ filename: n, enabled, size, ...info });
  }

  const problems = [];
  const accepted = ACCEPTS[d.kind];
  const active = mods.filter((m) => m.enabled);
  const provided = new Set();
  for (const m of active) { if (m.id) provided.add(m.id); for (const p of m.provides || []) provided.add(p); }
  const hasFabricApi = provided.has('fabric-api') || provided.has('fabric') || provided.has('quilted_fabric_api');

  for (const m of active) {
    const label = m.name || m.filename;
    if (m.loader === 'broken') { problems.push({ level: 'error', file: m.filename, text: `${label}: файл повреждён или это не jar-архив.` }); continue; }
    if (accepted && m.loader !== 'unknown' && !accepted.includes(m.loader)) {
      problems.push({ level: 'error', file: m.filename, kind: 'loader', text: `${label}: это мод для ${LOADER_NAMES[m.loader] || m.loader}, а сборка — ${LOADER_NAMES[d.kind] || d.kind}. Игра, скорее всего, не запустится.` });
      continue;
    }
    if (m.mc != null && d.mc) {
      const ok = mcMatches(m.mc, d.mc);
      if (ok === false) problems.push({ level: 'error', file: m.filename, kind: 'mc', text: `${label}: рассчитан на Minecraft ${Array.isArray(m.mc) ? m.mc.join(' или ') : m.mc}, а в сборке ${d.mc}.` });
    }
    for (const dep of m.depends || []) {
      if (provided.has(dep.id)) continue;
      if (hasFabricApi && (dep.id === 'fabric' || /^fabric-.+-v\d+$/.test(dep.id) || dep.id === 'fabric-api-base')) continue;
      problems.push({ level: 'warn', file: m.filename, kind: 'dep', text: `${label}: нужен мод «${dep.id}», его нет среди включённых.` });
    }
  }
  const seen = new Map();
  for (const m of active) {
    if (!m.id) continue;
    if (seen.has(m.id)) problems.push({ level: 'error', file: m.filename, kind: 'dup', text: `Два файла одного мода «${m.id}»: ${seen.get(m.id)} и ${m.filename}. Оставьте один.` });
    else seen.set(m.id, m.filename);
  }
  return { kind: d.kind, mc: d.mc, mods, problems };
}

/** Включает или выключает мод. Манифесты (маркет, библиотеки) хранят «базовое» имя .jar и при выключении не меняются. */
async function setEnabled({ root, versionId, filename, enabled }) {
  const dir = modsDir(root, versionId);
  const name = path.basename(String(filename || ''));
  if (name !== filename || !isModFile(name)) throw new Error('Некорректное имя файла мода.');
  const base = name.replace(/\.disabled$/i, '');
  const from = path.join(dir, name);
  const to = path.join(dir, enabled ? base : `${base}.disabled`);
  if (from === to) return { filename: path.basename(to), enabled: !!enabled };
  try { await fsp.access(to); throw new Error(`Файл ${path.basename(to)} уже существует. Удалите или переименуйте один из них.`); } catch (e) { if (e.message.startsWith('Файл')) throw e; }
  await fsp.rename(from, to);
  return { filename: path.basename(to), enabled: !!enabled };
}

module.exports = { scan, setEnabled, readJarInfo, mcMatches, parseModsToml, isModFile };
