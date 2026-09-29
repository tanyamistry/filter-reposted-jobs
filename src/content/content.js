/* Filter Reposted Jobs - content script.
   All selectors and tunables live in config.js. Nothing here should need
   editing when LinkedIn changes its markup. */
(function () {
  'use strict';

  var CFG = window.__LIRJ_CONFIG;
  var Store = window.LIRJStorage;

  /* If either of these is missing the whole script would die on the next
     line with a bare TypeError, and the popup would just say "not
     responding". Say what actually went wrong instead. */
  if (!CFG || !Store) {
    console.error('[filter-reposted-jobs] not starting: ' +
      (!CFG ? 'config.js' : 'storage.js') + ' did not load. ' +
      'Check the content_scripts file order in manifest.json.');
    return;
  }

  var K = Store.KEYS;

  var state = {
    settings: null,
    reposted: {},
    checked: {},
    applied: {},
    dismissed: {},
    filteredOnPage: 0,         // cards hidden or dimmed right now
    currentJobId: null,
    lastHref: location.href,
    paneToken: 0,              // invalidates in-flight pane verification
    bg: { queue: [], running: false, delay: CFG.BG.intervalMs, lastError: null }
  };

  var observer = null;         // set in start(); refresh() runs detached

  function log() {
    if (!CFG.DEBUG) return;
    console.log.apply(console, ['[filter-reposted-jobs]'].concat([].slice.call(arguments)));
  }

  /* ===================== small helpers ===================== */

  function onJobsPage() {
    return CFG.PATHS.some(function (p) { return location.pathname.indexOf(p) === 0; });
  }

  function currentJobIdFromUrl() {
    try {
      var v = new URL(location.href).searchParams.get('currentJobId');
      return v && /^\d+$/.test(v) ? v : null;
    } catch (e) { return null; }
  }

  function isForeign(el) {
    if (!el || el.nodeType !== 1) return false;
    return CFG.FOREIGN_SUBTREES.some(function (sel) {
      try { return el.closest(sel) !== null; } catch (e) { return false; }
    });
  }

  function inCard(el) {
    try { return !!(el && el.closest && el.closest(CFG.CARD.selector)); } catch (e) { return false; }
  }

  function textOf(el) {
    return el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  /* Run a DOM-mutating pass with the observer detached, so our own writes
     cannot feed back in as mutations. takeRecords() discards anything queued
     while we were working. */
  function guarded(fn) {
    if (!observer) { fn(); return; }
    observer.disconnect();
    try { fn(); } finally {
      observer.takeRecords();
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  function idFromString(s) {
    if (!s) return null;
    var m = String(s).match(/urn:li:jobPosting:(\d+)/) ||
            String(s).match(/\/jobs\/view\/(\d+)/) ||
            String(s).match(/(\d{6,})\s*$/);
    return m ? m[1] : null;
  }

  /* Smallest element containing every node in `nodes`. */
  function commonAncestor(nodes) {
    if (!nodes.length) return null;
    var a = nodes[0];
    for (var i = 1; i < nodes.length; i++) {
      var b = nodes[i];
      while (a && !a.contains(b)) a = a.parentElement;
      if (!a) return null;
    }
    return a;
  }

  /* ===================== finding job cards ===================== */

  /* Cards are identified by componentkey="job-card-component-ref-<jobId>".
     Several elements in one card can share that key, so the card element is
     their common ancestor - unless that ancestor swallows a different card,
     in which case we fall back to the outermost keyed element. */
  function getCards() {
    var byId = Object.create(null);
    var nodes = document.querySelectorAll(CFG.CARD.selector);

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (isForeign(el)) continue;
      var key = el.getAttribute('componentkey') || '';
      var id = key.slice(CFG.CARD.keyPrefix.length);
      if (!/^\d+$/.test(id)) continue;
      (byId[id] = byId[id] || []).push(el);
    }

    var ids = Object.keys(byId);
    if (ids.length) {
      return ids.map(function (id) {
        var group = byId[id];
        var root = commonAncestor(group) || group[0];
        // Guard against climbing above this card into the whole list.
        var foreignKeys = root.querySelectorAll(CFG.CARD.selector);
        for (var j = 0; j < foreignKeys.length; j++) {
          var k = foreignKeys[j].getAttribute('componentkey') || '';
          if (k.slice(CFG.CARD.keyPrefix.length) !== id) { root = group[0]; break; }
        }
        return { el: root, id: id };
      });
    }

    return getCardsFallback();
  }

  /* Older / alternate layouts. */
  function getCardsFallback() {
    for (var i = 0; i < CFG.CARD.fallbackSelectors.length; i++) {
      var found = [];
      var nodes = document.querySelectorAll(CFG.CARD.fallbackSelectors[i]);
      for (var j = 0; j < nodes.length; j++) {
        var el = nodes[j];
        if (isForeign(el)) continue;
        var id = fallbackCardId(el);
        if (id) found.push({ el: el, id: id });
      }
      if (found.length) return found;
    }
    return [];
  }

  function fallbackCardId(el) {
    var attrs = CFG.CARD.fallbackIdAttributes;
    for (var i = 0; i < attrs.length; i++) {
      var id = idFromString(el.getAttribute(attrs[i]));
      if (id) return id;
      var inner = el.querySelector('[' + attrs[i] + ']');
      if (inner) {
        id = idFromString(inner.getAttribute(attrs[i]));
        if (id) return id;
      }
    }
    var a = el.querySelector(CFG.CARD.fallbackJobLink);
    return a ? idFromString(a.getAttribute('href')) : null;
  }

  /* ===================== reading the details pane ===================== */

  /* Does the DOM contain a pane section stamped with this job id? This is the
     authoritative "the pane has caught up" test. */
  function paneCarriesId(jobId) {
    if (!jobId) return false;
    var nodes = document.querySelectorAll('[componentkey$="_' + jobId + '"], [id$="_' + jobId + '"]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (isForeign(el)) continue;
      var key = el.getAttribute('componentkey') || el.id || '';
      if (key.indexOf(CFG.CARD.keyPrefix) === 0) continue;   // that's a card
      for (var j = 0; j < CFG.PANE.markerPrefixes.length; j++) {
        if (key.indexOf(CFG.PANE.markerPrefixes[j]) === 0) return true;
      }
    }
    return false;
  }

  /* The pane's metadata line: a <p> holding a <strong> that looks like a
     posted time, outside any job card and outside foreign subtrees. */
  function getPaneMeta() {
    var ps = document.querySelectorAll(CFG.PANE.metaContainer);
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (isForeign(p) || inCard(p)) continue;
      var strong = p.querySelector(CFG.PANE.timeEmphasis);
      if (!strong) continue;
      var t = textOf(strong);
      if (CFG.TEXT.timeAgo.test(t) || CFG.TEXT.reposted.test(t)) {
        return { p: p, strong: strong, strongText: t };
      }
    }
    return null;
  }

  /* Walk up from the metadata line looking for the job title. Deliberately
     does NOT use document.querySelector('h1') - that finds Jobright's banner
     heading on pages where that extension is installed. Among the headings in
     each ancestor we take the LAST one that precedes the metadata line, which
     is the title rather than a later section heading like "About the job". */
  function getPaneTitleEl(meta) {
    if (!meta) return null;
    var sel = CFG.PANE.titleSelectors.join(',');
    var node = meta.p.parentElement;

    for (var d = 0; d < CFG.PANE.titleSearchDepth && node; d++, node = node.parentElement) {
      var candidates = node.querySelectorAll(sel);
      var best = null;
      for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        if (isForeign(c) || inCard(c) || !textOf(c)) continue;
        var rel = c.compareDocumentPosition(meta.p);
        if (rel & Node.DOCUMENT_POSITION_FOLLOWING) best = c;   // c comes first
      }
      if (best) return best;
    }
    return null;
  }

  function scrapeCompany(meta, titleEl) {
    var scope = titleEl || (meta && meta.p) || null;
    for (var d = 0; d < 7 && scope; d++, scope = scope.parentElement) {
      var labelled = scope.querySelectorAll('[aria-label]');
      for (var i = 0; i < labelled.length; i++) {
        if (isForeign(labelled[i]) || inCard(labelled[i])) continue;
        var m = (labelled[i].getAttribute('aria-label') || '').match(CFG.PANE.companyAriaPattern);
        if (m) return m[1].trim();
      }
      var link = scope.querySelector(CFG.PANE.companyLinkSelector);
      if (link && !isForeign(link) && !inCard(link) && textOf(link)) return textOf(link);
    }
    return '';
  }

  function fromDocumentTitle() {
    var m = (document.title || '').match(CFG.PANE.documentTitlePattern);
    return m ? { company: m[1].trim(), title: m[2].trim(), location: m[3].trim() } : null;
  }

  /* Everything we can scrape about whatever the pane is currently showing. */
  function readPane() {
    var meta = getPaneMeta();
    var titleEl = getPaneTitleEl(meta);
    var fallback = fromDocumentTitle() || {};

    var title = textOf(titleEl) || fallback.title || '';
    var company = scrapeCompany(meta, titleEl) || fallback.company || '';

    var location_ = '';
    if (meta) {
      var spans = meta.p.querySelectorAll('span');
      for (var s = 0; s < spans.length; s++) {
        var t = textOf(spans[s]);
        if (t && t !== '·' && !CFG.TEXT.timeAgo.test(t) && !CFG.TEXT.reposted.test(t)) {
          location_ = t;
          break;
        }
      }
    }
    if (!location_) location_ = fallback.location || '';

    return {
      title: title,
      company: company,
      location: location_,
      metaText: meta ? meta.strongText : '',
      /* true / false / null - null means "could not read", which must never
         be treated as "not reposted". */
      isReposted: meta ? CFG.TEXT.reposted.test(meta.strongText) : null,
      isApplied: paneSaysApplied(meta)
    };
  }

  function paneSaysApplied(meta) {
    if (!meta) return false;
    var root = meta.p;
    for (var i = 0; i < 5 && root.parentElement; i++) root = root.parentElement;
    if (isForeign(root)) return false;
    return CFG.TEXT.applied.test(textOf(root));
  }

  /* ---- the pane-lags-the-URL problem ----
     The pane keeps rendering the PREVIOUS job for a moment after
     currentJobId changes; reading too early attributes the old job's
     "Reposted" to the new one. Two conditions must hold before we read:
       a) a JobDetails*_<newId> marker exists, and
       b) the PREVIOUS job's markers are gone - otherwise both jobs are
          briefly mounted and the metadata line we find may still be the
          old one.
     Then we let it settle. Timing out resolves to null = "unknown", which
     is never treated as "not reposted". */
  function verifyPane(jobId, prevJobId, token) {
    var deadline = Date.now() + CFG.TIMING.paneVerifyTimeoutMs;

    return new Promise(function (resolve) {
      (function poll() {
        if (token !== state.paneToken) return resolve(null);        // superseded
        if (currentJobIdFromUrl() !== jobId) return resolve(null);  // moved on

        var ready = paneCarriesId(jobId) &&
                    (!prevJobId || prevJobId === jobId || !paneCarriesId(prevJobId));

        if (ready) {
          return setTimeout(function () {
            if (token !== state.paneToken) return resolve(null);
            if (currentJobIdFromUrl() !== jobId) return resolve(null);
            var info = readPane();
            resolve(info.metaText ? info : null);
          }, CFG.TIMING.paneSettleMs);
        }

        if (Date.now() > deadline) {
          log('pane verify timed out for', jobId);
          return resolve(null);
        }
        setTimeout(poll, CFG.TIMING.paneVerifyIntervalMs);
      })();
    });
  }

  /* ===================== applying the filter ===================== */

  function cardSaysReposted(el) {
    return /\breposted\b/i.test(textOf(el));
  }

  /* Marking MUST be idempotent. An earlier version cleared and re-applied the
     badge on every pass, which mutated the DOM, which woke the observer,
     which called refresh again - a permanent 5Hz loop in "dim" mode. Nothing
     here touches the DOM unless the result would actually differ. */
  function markCard(el, mode, label) {
    var hidden = el.classList.contains('lirj-hidden');
    var dim = el.classList.contains('lirj-dim');
    var badge = el.querySelector(':scope > .lirj-badge');

    if (mode === 'hidden') {
      if (dim) el.classList.remove('lirj-dim');
      if (!hidden) el.classList.add('lirj-hidden');
      if (badge) badge.remove();
      return;
    }

    if (mode === 'dim') {
      if (hidden) el.classList.remove('lirj-hidden');
      if (!dim) el.classList.add('lirj-dim');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'lirj-badge';
        badge.textContent = label;
        el.insertBefore(badge, el.firstChild);
      } else if (badge.textContent !== label) {
        badge.textContent = label;
      }
      return;
    }

    if (hidden) el.classList.remove('lirj-hidden');
    if (dim) el.classList.remove('lirj-dim');
    if (badge) badge.remove();
  }

  function refresh() {
    if (!state.settings || !state.settings.enabled || !onJobsPage()) {
      Array.prototype.forEach.call(
        document.querySelectorAll('.lirj-hidden, .lirj-dim'),
        function (el) { markCard(el, 'none'); });
      state.filteredOnPage = 0;
      return;
    }

    var cards = getCards();
    var current = state.currentJobId;
    var newlyReposted = [];
    var filtered = 0;

    cards.forEach(function (c) {
      var cardText = cardSaysReposted(c.el);
      if (cardText && !state.reposted[c.id]) newlyReposted.push(c.id);

      var isRepost = !!state.reposted[c.id] || cardText;
      var isApplied = state.settings.hideApplied && !!state.applied[c.id];

      if (!isRepost && !isApplied) { markCard(c.el, 'none'); return; }

      filtered++;
      var label = isRepost ? 'Reposted' : 'Applied';

      /* Never hide the job you are looking at - it would pull the pane's
         context out from under you. Dim it instead, whatever the mode. */
      if (c.id === current || state.settings.mode === 'dim') {
        markCard(c.el, 'dim', label);
      } else {
        markCard(c.el, 'hidden', label);
      }
    });

    state.filteredOnPage = filtered;
    if (newlyReposted.length) rememberReposted(newlyReposted);
    if (state.settings.backgroundCheck) enqueueUnchecked(cards);
  }

  function rememberReposted(ids) {
    if (!ids.length) return;
    ids.forEach(function (id) {
      state.reposted[id] = Date.now();
      state.checked[id] = Date.now();
    });
    Store.addIds(K.reposted, ids);
    Store.addIds(K.checked, ids);
    log('remembered reposted', ids);
  }

  function rememberChecked(id) {
    state.checked[id] = Date.now();
    Store.addIds(K.checked, [id]);
  }

  /* ===================== URL / pane change handling ===================== */

  function onUrlMaybeChanged() {
    if (location.href === state.lastHref) return;
    state.lastHref = location.href;

    var newId = currentJobIdFromUrl();
    if (newId === state.currentJobId) { guarded(refresh); return; }

    var prevId = state.currentJobId;
    state.currentJobId = newId;
    guarded(refresh);
    if (newId) inspectCurrentJob(newId, prevId);
  }

  function inspectCurrentJob(jobId, prevJobId) {
    var token = ++state.paneToken;
    verifyPane(jobId, prevJobId, token).then(function (info) {
      if (!info || token !== state.paneToken) return;
      if (info.isReposted === true) rememberReposted([jobId]);
      else if (info.isReposted === false) rememberChecked(jobId);
      if (info.isApplied) captureApplied(jobId, info, 'auto');
      guarded(function () { refresh(); injectPaneControls(); });
    });
  }

  /* ===================== applied-jobs tracker ===================== */

  function captureApplied(jobId, info, source) {
    if (!jobId) return Promise.resolve(null);
    return Store.upsertApplied(jobId, {
      title: info.title || '',
      company: info.company || '',
      location: info.location || '',
      url: 'https://www.linkedin.com/jobs/view/' + jobId + '/',
      source: source
    }).then(function (saved) {
      state.applied[jobId] = saved;
      guarded(refresh);
      return saved;
    });
  }

  /* "Mark as applied" button, injected beside the pane title. */
  function injectPaneControls() {
    var meta = getPaneMeta();
    var titleEl = getPaneTitleEl(meta);
    var host = titleEl && titleEl.parentElement;
    var id = state.currentJobId;

    if (!host || !id) {
      var orphan = document.querySelector('.lirj-mark-applied');
      if (orphan && !id) orphan.remove();
      return;
    }

    var btn = host.querySelector(':scope > .lirj-mark-applied');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lirj-mark-applied';
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var jid = state.currentJobId;
        if (!jid) return;
        if (state.applied[jid]) {
          Store.deleteApplied(jid).then(function () {
            delete state.applied[jid];
            guarded(function () { refresh(); injectPaneControls(); });
          });
        } else {
          captureApplied(jid, readPane(), 'manual').then(injectPaneControls);
        }
      });
      host.appendChild(btn);
    }

    var on = !!state.applied[id];
    btn.textContent = on ? '✓ Saved to applied jobs' : 'Mark as applied';
    btn.classList.toggle('lirj-on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  /* "Did you apply?" prompt, for external apply buttons LinkedIn cannot
     confirm on its own. */
  function showApplyPrompt(jobId, info) {
    if (document.querySelector('.lirj-prompt')) return;

    var card = document.createElement('div');
    card.className = 'lirj-prompt';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Save this job to your applied list');

    var head = document.createElement('p');
    head.className = 'lirj-prompt__text';
    head.textContent = 'Did you apply? Save to your list';

    var sub = document.createElement('p');
    sub.className = 'lirj-prompt__sub';
    sub.textContent = [info.title, info.company].filter(Boolean).join(' · ') || ('Job ' + jobId);

    var row = document.createElement('div');
    row.className = 'lirj-prompt__row';

    var save = document.createElement('button');
    save.type = 'button';
    save.className = 'lirj-btn lirj-btn--primary';
    save.textContent = 'Save';
    save.addEventListener('click', function () {
      captureApplied(jobId, info, 'prompt').then(function () {
        card.remove();
        injectPaneControls();
      });
    });

    var dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'lirj-btn';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', function () {
      state.dismissed[jobId] = Date.now();
      Store.addIds(K.dismissed, [jobId]);
      card.remove();
    });

    row.appendChild(save);
    row.appendChild(dismiss);
    card.appendChild(head);
    card.appendChild(sub);
    card.appendChild(row);
    document.body.appendChild(card);
    save.focus();
  }

  function onDocumentClick(e) {
    var el = e.target && e.target.closest ? e.target.closest('button, a, [role="button"]') : null;
    if (!el || isForeign(el)) return;

    var label = textOf(el);
    if (!label || label.length > 40) return;
    if (CFG.TEXT.easyApply.test(label)) return;        // LinkedIn confirms these itself
    if (!CFG.TEXT.applyButton.test(label)) return;

    var jobId = state.currentJobId;
    if (!jobId || state.applied[jobId] || state.dismissed[jobId]) return;

    var info = readPane();
    setTimeout(function () { showApplyPrompt(jobId, info); }, 800);
  }

  /* Easy Apply success: the confirmation appears in a dialog. */
  function checkEasyApplyConfirmation() {
    var jobId = state.currentJobId;
    if (!jobId || state.applied[jobId]) return;
    var dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
    for (var i = 0; i < dialogs.length; i++) {
      if (isForeign(dialogs[i])) continue;
      if (CFG.TEXT.applicationSent.test(textOf(dialogs[i]))) {
        captureApplied(jobId, readPane(), 'easy-apply');
        return;
      }
    }
  }

  /* ===================== optional background check ===================== */

  function csrfToken() {
    var m = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
    return m ? m[1] : null;
  }

  function voyagerFetch(jobId) {
    var token = csrfToken();
    if (!token) return Promise.reject(Object.assign(new Error('no-csrf'), { code: 'no-csrf' }));
    return fetch(CFG.BG.endpoint + jobId, {
      credentials: 'include',
      headers: {
        'csrf-token': token,
        'x-restli-protocol-version': '2.0.0',
        'accept': 'application/json'
      }
    }).then(function (res) {
      if (res.status === 429) throw Object.assign(new Error('rate-limited'), { code: 429 });
      if (!res.ok) throw Object.assign(new Error('http-' + res.status), { code: res.status });
      return res.json();
    });
  }

  function pickNumber(json, fields) {
    var scopes = [json, json && json.data, json && json.elements && json.elements[0]];
    for (var s = 0; s < scopes.length; s++) {
      if (!scopes[s]) continue;
      for (var f = 0; f < fields.length; f++) {
        if (typeof scopes[s][fields[f]] === 'number') return scopes[s][fields[f]];
      }
    }
    return null;
  }

  /* true / false / null ("the response did not tell us"). */
  function repostFromResponse(json) {
    var listed = pickNumber(json, CFG.BG.listedAtFields);
    var original = pickNumber(json, CFG.BG.originalListedAtFields);
    if (listed === null || original === null) return null;
    return (listed - original) > CFG.BG.repostThresholdMs;
  }

  function enqueueUnchecked(cards) {
    cards.forEach(function (c) {
      if (state.reposted[c.id] || state.checked[c.id]) return;
      if (state.bg.queue.indexOf(c.id) !== -1) return;
      state.bg.queue.push(c.id);
    });
    runQueue();
  }

  function runQueue() {
    if (state.bg.running) return;
    if (!state.settings || !state.settings.backgroundCheck) return;
    if (state.settings.bgStatus === 'unavailable') return;
    if (!state.bg.queue.length) return;

    state.bg.running = true;
    var jobId = state.bg.queue.shift();

    voyagerFetch(jobId).then(function (json) {
      var verdict = repostFromResponse(json);
      if (verdict === null) {
        /* The endpoint answered, but without the fields we rely on. Refuse to
           guess: turn the feature off and say so in the popup. */
        state.bg.lastError = 'fields-missing';
        return Store.setSettings({ bgStatus: 'unavailable' }).then(function (s) {
          state.settings = s;
          log('background check disabled: no listedAt/originalListedAt in response');
        });
      }
      if (state.settings.bgStatus !== 'ok') {
        Store.setSettings({ bgStatus: 'ok' }).then(function (s) { state.settings = s; });
      }
      if (verdict) rememberReposted([jobId]); else rememberChecked(jobId);
      state.bg.delay = CFG.BG.intervalMs;          // success resets backoff
      guarded(refresh);
    }).catch(function (err) {
      state.bg.lastError = err.code || err.message;
      if (err.code === 429) {
        state.bg.delay = Math.min(state.bg.delay * CFG.BG.backoffFactor, CFG.BG.maxBackoffMs);
        state.bg.queue.unshift(jobId);             // retry this one later
        log('429, backing off to', state.bg.delay, 'ms');
      } else if (err.code === 'no-csrf' || err.code === 401 || err.code === 403 || err.code === 404) {
        Store.setSettings({ bgStatus: 'unavailable' }).then(function (s) { state.settings = s; });
        log('background check disabled:', err.message);
      }
    }).then(function () {
      setTimeout(function () { state.bg.running = false; runQueue(); }, state.bg.delay);
    });
  }

  /* ===================== diagnostics (popup button) ===================== */

  function diagnose() {
    var cards = getCards();
    var meta = getPaneMeta();
    var titleEl = getPaneTitleEl(meta);
    var pane = readPane();
    var id = state.currentJobId;

    return {
      extension: 'filter-reposted-jobs 0.1.0',
      when: new Date().toISOString(),
      page: { path: location.pathname, currentJobId: id, onJobsPage: onJobsPage() },
      cards: {
        found: cards.length,
        via: cards.length
          ? (document.querySelector(CFG.CARD.selector) ? 'componentkey' : 'fallback selectors')
          : 'NOTHING MATCHED - card detection is broken',
        sample: cards.slice(0, 3).map(function (c) {
          return {
            id: c.id,
            tag: c.el.tagName,
            attrs: [].slice.call(c.el.attributes).map(function (a) {
              return a.name + '=' + String(a.value).slice(0, 60);
            }),
            text: textOf(c.el).slice(0, 160),
            cardTextSaysReposted: cardSaysReposted(c.el),
            knownReposted: !!state.reposted[c.id]
          };
        })
      },
      pane: {
        markerFound: id ? paneCarriesId(id) : null,
        metaFound: !!meta,
        metaHTML: meta ? meta.p.outerHTML.slice(0, 800) : null,
        strongText: pane.metaText,
        isReposted: pane.isReposted,
        isApplied: pane.isApplied,
        title: pane.title,
        titleTag: titleEl ? titleEl.tagName : null,
        company: pane.company,
        location: pane.location
      },
      store: {
        reposted: Object.keys(state.reposted).length,
        checked: Object.keys(state.checked).length,
        applied: Object.keys(state.applied).length,
        filteredOnPage: state.filteredOnPage
      },
      settings: state.settings,
      backgroundCheck: {
        queued: state.bg.queue.length,
        delayMs: state.bg.delay,
        lastError: state.bg.lastError,
        haveCsrf: !!csrfToken()
      }
    };
  }

  /* ===================== messaging ===================== */

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;

    if (msg.type === 'lirj:getPageStats') {
      sendResponse({ filteredOnPage: state.filteredOnPage, onJobsPage: onJobsPage() });
      return true;
    }
    if (msg.type === 'lirj:diagnose') {
      sendResponse(diagnose());
      return true;
    }
    if (msg.type === 'lirj:settingsChanged') {
      Store.getSettings().then(function (s) {
        state.settings = s;
        state.bg.delay = CFG.BG.intervalMs;
        guarded(function () { refresh(); injectPaneControls(); });
      });
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'lirj:dataChanged') {
      loadMaps().then(function () {
        guarded(function () { refresh(); injectPaneControls(); });
      });
      sendResponse({ ok: true });
      return true;
    }
  });

  console.log('[filter-reposted-jobs] active on ' + location.pathname);

  /* ===================== boot ===================== */

  function loadMaps() {
    return Promise.all([
      Store.getMap(K.reposted),
      Store.getMap(K.checked),
      Store.getMap(K.applied),
      Store.getMap(K.dismissed)
    ]).then(function (r) {
      state.reposted = r[0];
      state.checked = r[1];
      state.applied = r[2];
      state.dismissed = r[3];
    });
  }

  var debounceTimer = null;
  function onMutations(records) {
    for (var i = 0; i < records.length; i++) {
      var t = records[i].target;
      if (t && t.nodeType === 1 && isForeign(t)) continue;   // ignore other extensions
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        guarded(function () { refresh(); injectPaneControls(); });
        checkEasyApplyConfirmation();
      }, CFG.TIMING.mutationDebounceMs);
      return;
    }
  }

  function start() {
    state.currentJobId = currentJobIdFromUrl();

    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true });

    setInterval(onUrlMaybeChanged, CFG.TIMING.urlPollMs);
    window.addEventListener('popstate', onUrlMaybeChanged);
    document.addEventListener('click', onDocumentClick, true);

    guarded(function () { refresh(); injectPaneControls(); });

    // On first load the pane may already be showing a reposted job.
    if (state.currentJobId) inspectCurrentJob(state.currentJobId, null);
  }

  Store.getSettings()
    .then(function (s) { state.settings = s; return loadMaps(); })
    .then(start)
    .catch(function (err) {
      console.error('[filter-reposted-jobs] failed to start', err);
    });
})();
