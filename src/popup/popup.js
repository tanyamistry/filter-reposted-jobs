(function () {
  'use strict';

  var Store = window.LIRJStorage;
  var K = Store.KEYS;

  var el = {
    enabled: document.getElementById('enabled'),
    enabledLabel: document.getElementById('enabledLabel'),
    mode: document.getElementById('mode'),
    hideApplied: document.getElementById('hideApplied'),
    backgroundCheck: document.getElementById('backgroundCheck'),
    bgHint: document.getElementById('bgHint'),
    statPage: document.getElementById('statPage'),
    statTotal: document.getElementById('statTotal'),
    statApplied: document.getElementById('statApplied'),
    openApplied: document.getElementById('openApplied'),
    diagnose: document.getElementById('diagnose'),
    forget: document.getElementById('forget'),
    status: document.getElementById('status')
  };

  var BG_HINT_DEFAULT =
    "Looks up jobs you haven't opened yet, one every 1.5 s, to catch reposts " +
    'before you click. Experimental.';

  function say(msg, isWarning) {
    el.status.textContent = msg || '';
    el.status.classList.toggle('warn', !!isWarning);
  }

  function activeTab() {
    return new Promise(function (resolve) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        resolve(tabs && tabs[0] ? tabs[0] : null);
      });
    });
  }

  /* The content script only exists on LinkedIn job pages; a failed send is
     normal, not an error to show. */
  function askContent(type) {
    return activeTab().then(function (tab) {
      if (!tab) return null;
      return new Promise(function (resolve) {
        chrome.tabs.sendMessage(tab.id, { type: type }, function (res) {
          void chrome.runtime.lastError;
          resolve(res || null);
        });
      });
    });
  }

  function notifyContent(type) {
    return askContent(type);
  }

  function renderSettings(s) {
    el.enabled.checked = !!s.enabled;
    el.enabledLabel.textContent = s.enabled ? 'On' : 'Off';
    el.mode.value = s.mode;
    el.hideApplied.checked = !!s.hideApplied;
    el.backgroundCheck.checked = !!s.backgroundCheck;

    if (s.backgroundCheck && s.bgStatus === 'unavailable') {
      el.bgHint.textContent =
        "Turned itself off: LinkedIn's response didn't contain the repost " +
        'dates this relies on. Details-pane detection still works.';
      el.bgHint.classList.add('warn');
    } else if (s.backgroundCheck && s.bgStatus === 'ok') {
      el.bgHint.textContent = 'Working. Checking about one job every 1.5 s.';
      el.bgHint.classList.remove('warn');
    } else {
      el.bgHint.textContent = BG_HINT_DEFAULT;
      el.bgHint.classList.remove('warn');
    }
  }

  function refreshStats() {
    Store.counts().then(function (c) {
      el.statTotal.textContent = c.reposted;
      el.statApplied.textContent = c.applied;
    });
    askContent('lirj:getPageStats').then(function (res) {
      el.statPage.textContent = res && res.onJobsPage ? res.filteredOnPage : '–';
    });
  }

  function save(patch) {
    return Store.setSettings(patch).then(function (s) {
      renderSettings(s);
      return notifyContent('lirj:settingsChanged').then(function () {
        setTimeout(refreshStats, 250);
        return s;
      });
    });
  }

  /* ---- wiring ---- */

  el.enabled.addEventListener('change', function () {
    save({ enabled: el.enabled.checked });
  });

  el.mode.addEventListener('change', function () {
    save({ mode: el.mode.value });
  });

  el.hideApplied.addEventListener('change', function () {
    save({ hideApplied: el.hideApplied.checked });
  });

  el.backgroundCheck.addEventListener('change', function () {
    // Re-enabling clears a previous "unavailable" verdict so it can retry.
    var patch = { backgroundCheck: el.backgroundCheck.checked };
    if (el.backgroundCheck.checked) patch.bgStatus = 'untested';
    save(patch);
  });

  el.openApplied.addEventListener('click', function () {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/applied.html') });
    window.close();
  });

  el.diagnose.addEventListener('click', function () {
    askContent('lirj:diagnose').then(function (res) {
      if (!res) {
        say('Open a LinkedIn job search tab first, then try again.', true);
        return;
      }
      var text = JSON.stringify(res, null, 2);
      navigator.clipboard.writeText(text).then(function () {
        say('Diagnostics copied to clipboard.');
      }, function () {
        console.log(text);
        say('Could not copy. Diagnostics logged to the popup console.', true);
      });
    });
  });

  el.forget.addEventListener('click', function () {
    Store.counts().then(function (c) {
      var ok = window.confirm(
        'Forget ' + c.reposted + ' remembered reposted job(s)?\n\n' +
        'This also clears the record of which jobs have been checked, so they ' +
        'will be looked at again. Your applied jobs are not affected.');
      if (!ok) return;
      Promise.all([Store.clearMap(K.reposted), Store.clearMap(K.checked)])
        .then(function () { return notifyContent('lirj:dataChanged'); })
        .then(function () {
          say('Forgotten.');
          setTimeout(refreshStats, 250);
        });
    });
  });

  Store.getSettings().then(function (s) {
    renderSettings(s);
    refreshStats();
  });
})();
