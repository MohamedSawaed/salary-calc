/*
 * ShiftPay cloud module — Firebase Auth + Firestore via REST (no SDK).
 * Works in the browser PWA, the Capacitor APK, and Node (for tests).
 * Config is read lazily from global.FIREBASE = { apiKey, projectId }.
 *
 * Data model: one Firestore doc per user at users/{uid}, with a single string
 * field "data" holding JSON.stringify({ profile, shifts }). Security rules let a
 * signed-in user read/write only their own doc.
 */
(function (global) {
  'use strict';

  function cfg() { return global.FIREBASE || {}; }
  function configured() { var c = cfg(); return !!(c.apiKey && c.projectId); }

  var IDP = 'https://identitytoolkit.googleapis.com/v1/accounts:';
  var TKN = 'https://securetoken.googleapis.com/v1/token';
  function docUrl(uid) {
    return 'https://firestore.googleapis.com/v1/projects/' + cfg().projectId +
      '/databases/(default)/documents/users/' + encodeURIComponent(uid);
  }

  function mkErr(e) { var m = (e && e.message) || 'ERROR'; var err = new Error(m); err.code = m; return err; }

  function jpost(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (j.error) throw mkErr(j.error); return j; }); });
  }

  function signUp(email, password) {
    return jpost(IDP + 'signUp?key=' + cfg().apiKey, { email: email, password: password, returnSecureToken: true });
  }
  function signIn(email, password) {
    return jpost(IDP + 'signInWithPassword?key=' + cfg().apiKey, { email: email, password: password, returnSecureToken: true });
  }
  function refresh(refreshToken) {
    return fetch(TKN + '?key=' + cfg().apiKey, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(refreshToken)
    }).then(function (r) { return r.json(); }).then(function (j) { if (j.error) throw mkErr(j.error); return j; });
  }

  /* ---- JS <-> Firestore typed-value converters (so fields are readable in the console) ---- */
  function toFs(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === 'string') return { stringValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
    if (typeof v === 'object') {
      var fields = {};
      Object.keys(v).forEach(function (k) { fields[k] = toFs(v[k]); });
      return { mapValue: { fields: fields } };
    }
    return { stringValue: String(v) };
  }
  function fromFs(f) {
    if (!f) return null;
    if ('nullValue' in f) return null;
    if ('booleanValue' in f) return f.booleanValue;
    if ('integerValue' in f) return parseInt(f.integerValue, 10);
    if ('doubleValue' in f) return f.doubleValue;
    if ('stringValue' in f) return f.stringValue;
    if ('timestampValue' in f) return f.timestampValue;
    if ('arrayValue' in f) return (f.arrayValue.values || []).map(fromFs);
    if ('mapValue' in f) {
      var o = {}, fl = f.mapValue.fields || {};
      Object.keys(fl).forEach(function (k) { o[k] = fromFs(fl[k]); });
      return o;
    }
    return null;
  }

  /** Returns a normalized object { name, hourlyWage, currency, email, shifts, updatedAt } or null. */
  function load(uid, idToken) {
    return fetch(docUrl(uid), { headers: { Authorization: 'Bearer ' + idToken } }).then(function (r) {
      if (r.status === 404) return null;
      return r.json().then(function (j) {
        if (j.error) throw mkErr(j.error);
        var f = j.fields; if (!f) return null;
        if (f.data && f.data.stringValue) { // legacy single-blob format -> normalize
          try {
            var o = JSON.parse(f.data.stringValue);
            return { name: o.profile && o.profile.name, hourlyWage: o.profile && o.profile.rate,
              currency: o.profile && o.profile.currency, shifts: o.shifts || {} };
          } catch (e) { return null; }
        }
        return fromFs({ mapValue: { fields: f } });
      });
    });
  }

  /** obj = { name, hourlyWage, currency, email, shifts }. Stored as separate readable fields. */
  function save(uid, idToken, obj) {
    var fields = {
      name: toFs(obj.name || ''),
      hourlyWage: toFs(obj.hourlyWage || 0),
      currency: toFs(obj.currency || ''),
      email: toFs(obj.email || ''),
      extras: toFs(obj.extras || []),
      updatedAt: { timestampValue: new Date().toISOString() },
      shifts: toFs(obj.shifts || {})
    };
    return fetch(docUrl(uid), { // no updateMask -> overwrite with this full, structured set
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + idToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: fields })
    }).then(function (r) { return r.json().then(function (j) { if (j.error) throw mkErr(j.error); return true; }); });
  }

  /** Admin only (allowed by rules): list every user's record. Returns [{ uid, name, hourlyWage, currency, email, shifts, updatedAt }]. */
  function listUsers(idToken) {
    var url = 'https://firestore.googleapis.com/v1/projects/' + cfg().projectId +
      '/databases/(default)/documents/users?pageSize=1000';
    return fetch(url, { headers: { Authorization: 'Bearer ' + idToken } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.error) throw mkErr(j.error);
        return (j.documents || []).map(function (doc) {
          var uid = doc.name.split('/').pop();
          var f = doc.fields || {};
          var obj;
          if (f.data && f.data.stringValue) { // legacy blob
            try { var o = JSON.parse(f.data.stringValue); obj = { name: o.profile && o.profile.name, hourlyWage: o.profile && o.profile.rate, currency: o.profile && o.profile.currency, shifts: o.shifts || {} }; }
            catch (e) { obj = {}; }
          } else { obj = fromFs({ mapValue: { fields: f } }) || {}; }
          obj.uid = uid;
          obj.shifts = obj.shifts || {};
          return obj;
        });
      });
  }

  var api = { configured: configured, signUp: signUp, signIn: signIn, refresh: refresh, load: load, save: save, listUsers: listUsers };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Cloud = api;
})(typeof window !== 'undefined' ? window : globalThis);
