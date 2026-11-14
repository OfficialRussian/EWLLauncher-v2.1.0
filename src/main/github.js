'use strict';
/**
 * Вход через GitHub (Device Flow) и проверка обновлений лаунчера.
 * Токен хранится зашифрованным (DPAPI), права запрашиваются минимальные: read:user.
 * Лаунчер ничего не скачивает и не устанавливает сам — только сообщает о новой версии.
 */
const fs = require('fs');
const path = require('path');
const { protect, unprotect } = require('./core/secrets');
const { check: checkRelease } = require('./updates');

const OWNER = 'OfficialRussian';
const UA = { 'User-Agent': 'EWLLauncher', Accept: 'application/vnd.github+json' };
const CLIENT_RE = /^[A-Za-z0-9._]{10,40}$/;

class GitHubAuth {
  constructor(file) { this.file = file; }

  _read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { return {}; }
  }

  token() { return unprotect(this._read().token || ''); }

  status() {
    const d = this._read();
    return { connected: !!this.token(), login: d.login || '' };
  }

  logout() { try { fs.rmSync(this.file, { force: true }); } catch (_) { /* */ } return this.status(); }

  /** Шаг 1: получить код, который пользователь вводит на github.com/login/device. */
  async start(clientId) {
    if (!CLIENT_RE.test(String(clientId || ''))) throw new Error('Не задан Client ID приложения GitHub (Настройки → Обновления).');
    const r = await fetch('https://github.com/login/device/code', {
      method: 'POST', headers: { ...UA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, scope: 'read:user' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.device_code) throw new Error(j.error_description || 'GitHub не выдал код входа. Проверьте Client ID и что в приложении включён Device Flow.');
    return {
      deviceCode: j.device_code, userCode: j.user_code,
      url: /^https:\/\/github\.com\//.test(j.verification_uri || '') ? j.verification_uri : 'https://github.com/login/device',
      interval: Math.max(5, Number(j.interval) || 5), expiresIn: Number(j.expires_in) || 900,
    };
  }

  /** Шаг 2: один опрос. Возвращает {state:'pending'|'slow'|'ok'|'denied'|'expired', login?}. */
  async poll(clientId, deviceCode) {
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { ...UA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.access_token) {
      let login = '';
      try {
        const u = await (await fetch('https://api.github.com/user', { headers: { ...UA, Authorization: `Bearer ${j.access_token}` } })).json();
        login = String(u.login || '').slice(0, 60);
      } catch (_) { /* логин не критичен */ }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ token: protect(j.access_token), login }), 'utf8');
      return { state: 'ok', login };
    }
    if (j.error === 'authorization_pending') return { state: 'pending' };
    if (j.error === 'slow_down') return { state: 'slow' };
    if (j.error === 'access_denied') return { state: 'denied' };
    if (j.error === 'expired_token') return { state: 'expired' };
    throw new Error(j.error_description || 'Ошибка входа через GitHub.');
  }

  /** Подписан ли вошедший пользователь на автора: 204 — да, 404 — нет. */
  async isFollowing(owner = OWNER) {
    const token = this.token();
    if (!token) return null;
    const r = await fetch(`https://api.github.com/user/following/${owner}`, { headers: { ...UA, Authorization: `Bearer ${token}` } });
    if (r.status === 204) return true;
    if (r.status === 404) return false;
    if (r.status === 401) { this.logout(); return null; }
    throw new Error(`GitHub ответил ${r.status}`);
  }

  /**
   * Итог для окна: not-connected → not-following → new | latest | no-releases.
   * Репозиторий берётся из настроек (по умолчанию OfficialRussian/serfgg).
   */
  async checkUpdate({ repo, current }) {
    if (!this.token()) return { state: 'not-connected' };
    const following = await this.isFollowing();
    if (following === null) return { state: 'not-connected' };
    if (!following) return { state: 'not-following', profileUrl: `https://github.com/${OWNER}` };
    const r = await checkRelease({ repo, current });
    if (r.reason === 'no-releases' || r.reason === 'none') return { state: 'no-releases', current };
    if (r.available) return { state: 'new', version: r.version, url: r.url, notes: r.notes, current };
    return { state: 'latest', current, version: r.version };
  }
}

// Client ID — публичный идентификатор OAuth-приложения GitHub (не секрет). Впишите свой сюда или в Настройках.
const DEFAULT_CLIENT_ID = '';

module.exports = { GitHubAuth, OWNER, DEFAULT_CLIENT_ID };
