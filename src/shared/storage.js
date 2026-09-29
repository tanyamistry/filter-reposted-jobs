/* Shared storage layer. Loaded as a plain script by the content script, the
   popup and the applied-jobs page; exposes window.LIRJStorage. No modules, so
   there is no build step. */
(function () {
  'use strict';

  var KEYS = {
    settings: 'settings',
    reposted: 'reposted',   // { jobId: timestamp }  capped
    checked: 'checked',     // { jobId: timestamp }  capped
    applied: 'applied',     // { jobId: record }     NOT capped - it is your record
    dismissed: 'dismissed'  // { jobId: timestamp }  capped - "did you apply?" dismissals
  };

  var DEFAULT_SETTINGS = {
    enabled: true,
    mode: 'hide',            // 'hide' | 'dim'
    backgroundCheck: false,  // off by default
    hideApplied: false,
    bgStatus: 'untested'     // 'untested' | 'ok' | 'unavailable'
  };

  // Reposted/checked/dismissed are caches and get trimmed. Applied is never
  // trimmed: losing an application record is a real loss, losing a cache entry
  // just means one extra lookup.
  var CAPS = { reposted: 5000, checked: 5000, dismissed: 2000 };

  var APPLIED_STATUSES = ['Applied', 'Interviewing', 'Offer', 'Rejected', 'No response'];

  function get(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(keys, function (res) { resolve(res || {}); });
    });
  }

  function set(obj) {
    return new Promise(function (resolve) {
      chrome.storage.local.set(obj, function () { resolve(); });
    });
  }

  /* Drop the oldest entries (smallest timestamp) until the map fits the cap. */
  function trim(map, cap) {
    var ids = Object.keys(map);
    if (ids.length <= cap) return map;
    ids.sort(function (a, b) { return (map[a] || 0) - (map[b] || 0); });
    var drop = ids.length - cap;
    for (var i = 0; i < drop; i++) delete map[ids[i]];
    return map;
  }

  var API = {
    KEYS: KEYS,
    CAPS: CAPS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    APPLIED_STATUSES: APPLIED_STATUSES,

    getSettings: function () {
      return get(KEYS.settings).then(function (res) {
        var s = res[KEYS.settings] || {};
        var out = {};
        Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
          out[k] = (k in s) ? s[k] : DEFAULT_SETTINGS[k];
        });
        return out;
      });
    },

    setSettings: function (patch) {
      return API.getSettings().then(function (cur) {
        var next = Object.assign({}, cur, patch);
        return set$1(KEYS.settings, next).then(function () { return next; });
      });
    },

    getMap: function (key) {
      return get(key).then(function (res) { return res[key] || {}; });
    },

    /* Add ids to a capped map, stamped with now(). */
    addIds: function (key, ids) {
      if (!Array.isArray(ids)) ids = [ids];
      return API.getMap(key).then(function (map) {
        var now = Date.now();
        ids.forEach(function (id) { if (id) map[String(id)] = now; });
        if (CAPS[key]) trim(map, CAPS[key]);
        return set$1(key, map).then(function () { return map; });
      });
    },

    clearMap: function (key) { return set$1(key, {}); },

    /* ---- applied jobs ---- */

    getApplied: function () { return API.getMap(KEYS.applied); },

    /* Insert or merge one record. Existing fields win only where the incoming
       record leaves them empty, so an automatic re-detection never wipes notes
       or a status you set by hand. */
    upsertApplied: function (id, record) {
      id = String(id);
      return API.getApplied().then(function (map) {
        var prev = map[id] || {};
        var merged = Object.assign({}, prev, record);
        if (prev.notes) merged.notes = prev.notes;
        if (prev.status) merged.status = prev.status;
        if (prev.appliedAt) merged.appliedAt = prev.appliedAt;
        if (prev.source) merged.source = prev.source;
        merged.id = id;
        merged.status = merged.status || 'Applied';
        merged.notes = merged.notes || '';
        merged.appliedAt = merged.appliedAt || new Date().toISOString();
        merged.url = merged.url || ('https://www.linkedin.com/jobs/view/' + id + '/');
        map[id] = merged;
        return set$1(KEYS.applied, map).then(function () { return merged; });
      });
    },

    updateApplied: function (id, patch) {
      id = String(id);
      return API.getApplied().then(function (map) {
        if (!map[id]) return null;
        map[id] = Object.assign({}, map[id], patch);
        return set$1(KEYS.applied, map).then(function () { return map[id]; });
      });
    },

    deleteApplied: function (id) {
      id = String(id);
      return API.getApplied().then(function (map) {
        delete map[id];
        return set$1(KEYS.applied, map);
      });
    },

    replaceApplied: function (map) { return set$1(KEYS.applied, map || {}); },

    counts: function () {
      return get([KEYS.reposted, KEYS.checked, KEYS.applied]).then(function (res) {
        return {
          reposted: Object.keys(res[KEYS.reposted] || {}).length,
          checked: Object.keys(res[KEYS.checked] || {}).length,
          applied: Object.keys(res[KEYS.applied] || {}).length
        };
      });
    }
  };

  function set$1(key, value) {
    var o = {};
    o[key] = value;
    return set(o);
  }

  window.LIRJStorage = API;
})();
