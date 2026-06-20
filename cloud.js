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

  /** Returns the stored object, or null if the user has no cloud data yet. */
  function load(uid, idToken) {
    return fetch(docUrl(uid), { headers: { Authorization: 'Bearer ' + idToken } }).then(function (r) {
      if (r.status === 404) return null;
      return r.json().then(function (j) {
        if (j.error) throw mkErr(j.error);
        var d = j.fields && j.fields.data;
        return (d && d.stringValue) ? JSON.parse(d.stringValue) : null;
      });
    });
  }

  function save(uid, idToken, obj) {
    return fetch(docUrl(uid) + '?updateMask.fieldPaths=data', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + idToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { data: { stringValue: JSON.stringify(obj) } } })
    }).then(function (r) { return r.json().then(function (j) { if (j.error) throw mkErr(j.error); return true; }); });
  }

  var api = { configured: configured, signUp: signUp, signIn: signIn, refresh: refresh, load: load, save: save };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Cloud = api;
})(typeof window !== 'undefined' ? window : globalThis);
