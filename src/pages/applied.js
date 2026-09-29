(function () {
  'use strict';

  var Store = window.LIRJStorage;

  var el = {
    summary: document.getElementById('summary'),
    search: document.getElementById('search'),
    statusFilter: document.getElementById('statusFilter'),
    rows: document.getElementById('rows'),
    empty: document.getElementById('empty'),
    status: document.getElementById('status'),
    exportCsv: document.getElementById('exportCsv'),
    exportJson: document.getElementById('exportJson'),
    importBtn: document.getElementById('importBtn'),
    importFile: document.getElementById('importFile')
  };

  var data = {};                                   // id -> record
  var sort = { key: 'appliedAt', dir: 'desc' };

  function say(msg) { el.status.textContent = msg || ''; }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function records() {
    return Object.keys(data).map(function (id) {
      return Object.assign({ id: id }, data[id]);
    });
  }

  function filtered() {
    var q = el.search.value.trim().toLowerCase();
    var st = el.statusFilter.value;

    var list = records().filter(function (r) {
      if (st && r.status !== st) return false;
      if (!q) return true;
      return [r.title, r.company, r.location, r.notes, r.status]
        .filter(Boolean).join(' ').toLowerCase().indexOf(q) !== -1;
    });

    list.sort(function (a, b) {
      var x = (a[sort.key] || '').toString().toLowerCase();
      var y = (b[sort.key] || '').toString().toLowerCase();
      if (x < y) return sort.dir === 'asc' ? -1 : 1;
      if (x > y) return sort.dir === 'asc' ? 1 : -1;
      return 0;
    });
    return list;
  }

  function optionEl(value, label, selected) {
    var o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    if (selected) o.selected = true;
    return o;
  }

  function render() {
    var list = filtered();
    var total = Object.keys(data).length;

    el.summary.textContent = total === 0
      ? 'Nothing saved yet'
      : total + ' job' + (total === 1 ? '' : 's') +
        (list.length !== total ? ' · ' + list.length + ' shown' : '');

    el.rows.textContent = '';
    el.empty.hidden = total !== 0;

    list.forEach(function (r) {
      var tr = document.createElement('tr');

      // Job (title + link)
      var tdTitle = document.createElement('td');
      tdTitle.className = 'cell-title';
      var a = document.createElement('a');
      a.href = r.url || ('https://www.linkedin.com/jobs/view/' + r.id + '/');
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      a.textContent = r.title || ('Job ' + r.id);
      tdTitle.appendChild(a);
      tr.appendChild(tdTitle);

      tr.appendChild(textCell(r.company));
      tr.appendChild(textCell(r.location));
      tr.appendChild(textCell(fmtDate(r.appliedAt)));

      // How it was saved
      var tdSrc = document.createElement('td');
      var tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = r.source || 'manual';
      tdSrc.appendChild(tag);
      tr.appendChild(tdSrc);

      // Status
      var tdStatus = document.createElement('td');
      var sel = document.createElement('select');
      sel.setAttribute('aria-label', 'Status for ' + (r.title || r.id));
      Store.APPLIED_STATUSES.forEach(function (s) {
        sel.appendChild(optionEl(s, s, s === r.status));
      });
      sel.addEventListener('change', function () {
        Store.updateApplied(r.id, { status: sel.value }).then(function () {
          data[r.id].status = sel.value;
          say('Status updated.');
        });
      });
      tdStatus.appendChild(sel);
      tr.appendChild(tdStatus);

      // Notes
      var tdNotes = document.createElement('td');
      tdNotes.className = 'cell-notes';
      var ta = document.createElement('textarea');
      ta.rows = 1;
      ta.value = r.notes || '';
      ta.setAttribute('aria-label', 'Notes for ' + (r.title || r.id));
      ta.addEventListener('change', function () {
        Store.updateApplied(r.id, { notes: ta.value }).then(function () {
          data[r.id].notes = ta.value;
          say('Notes saved.');
        });
      });
      tdNotes.appendChild(ta);
      tr.appendChild(tdNotes);

      // Delete
      var tdDel = document.createElement('td');
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn--link';
      del.textContent = 'Delete';
      del.setAttribute('aria-label', 'Delete ' + (r.title || r.id));
      del.addEventListener('click', function () {
        if (!window.confirm('Delete "' + (r.title || r.id) + '" from your applied list?')) return;
        Store.deleteApplied(r.id).then(function () {
          delete data[r.id];
          render();
          say('Deleted.');
        });
      });
      tdDel.appendChild(del);
      tr.appendChild(tdDel);

      el.rows.appendChild(tr);
    });
  }

  function textCell(value) {
    var td = document.createElement('td');
    if (value) {
      td.textContent = value;
    } else {
      td.className = 'muted';
      td.textContent = '—';
    }
    return td;
  }

  /* ---- export / import ---- */

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function csvCell(v) {
    var s = v === undefined || v === null ? '' : String(v);
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function stamp() {
    return new Date().toISOString().slice(0, 10);
  }

  el.exportCsv.addEventListener('click', function () {
    var cols = ['id', 'title', 'company', 'location', 'url', 'appliedAt', 'source', 'status', 'notes'];
    var lines = [cols.join(',')];
    filtered().forEach(function (r) {
      lines.push(cols.map(function (c) { return csvCell(r[c]); }).join(','));
    });
    // BOM so Excel reads UTF-8 correctly
    download('applied-jobs-' + stamp() + '.csv', '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
    say('CSV exported.');
  });

  el.exportJson.addEventListener('click', function () {
    var payload = {
      kind: 'filter-reposted-jobs/applied',
      version: 1,
      exportedAt: new Date().toISOString(),
      jobs: data
    };
    download('applied-jobs-' + stamp() + '.json', JSON.stringify(payload, null, 2), 'application/json');
    say('JSON exported.');
  });

  el.importBtn.addEventListener('click', function () { el.importFile.click(); });

  el.importFile.addEventListener('change', function () {
    var file = el.importFile.files && el.importFile.files[0];
    if (!file) return;
    file.text().then(function (text) {
      var parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        say('That file is not valid JSON.');
        return;
      }
      var incoming = parsed && parsed.jobs ? parsed.jobs : parsed;
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        say('That file does not look like an applied-jobs export.');
        return;
      }

      var ids = Object.keys(incoming);
      var added = 0, merged = 0;
      ids.forEach(function (id) {
        if (!/^\d+$/.test(id)) return;
        var rec = incoming[id];
        if (!rec || typeof rec !== 'object') return;
        if (data[id]) { merged++; } else { added++; }
        // Existing entries win, so an import never overwrites newer edits.
        data[id] = Object.assign({}, rec, data[id]);
      });

      Store.replaceApplied(data).then(function () {
        render();
        say('Imported ' + added + ' new, kept ' + merged + ' existing.');
        el.importFile.value = '';
      });
    });
  });

  /* ---- sorting + filtering ---- */

  Array.prototype.forEach.call(document.querySelectorAll('.sort'), function (btn) {
    btn.addEventListener('click', function () {
      var key = btn.getAttribute('data-sort');
      if (sort.key === key) {
        sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sort.key = key;
        sort.dir = key === 'appliedAt' ? 'desc' : 'asc';
      }
      Array.prototype.forEach.call(document.querySelectorAll('.sort'), function (b) {
        b.removeAttribute('aria-sort');
      });
      btn.setAttribute('aria-sort', sort.dir === 'asc' ? 'ascending' : 'descending');
      render();
    });
  });

  el.search.addEventListener('input', render);
  el.statusFilter.addEventListener('change', render);

  /* ---- boot ---- */

  Store.APPLIED_STATUSES.forEach(function (s) {
    el.statusFilter.appendChild(optionEl(s, s, false));
  });

  Store.getApplied().then(function (map) {
    data = map;
    render();
  });
})();
