// Launch Radar v6 — the page's plain dashboard.
//
// It reads window.RADAR (written to ../data.js by main.ts), renders the ranked board with filters,
// a sortable table and a per-protocol detail view. The detail view prints the model's own
// decomposition: each component's input, its fitted weight and the dollars it contributes, so the
// number the board shows can be rebuilt by hand from the same four snapshot fields.
//
// No network, no framework, no build step: every byte it shows is in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) {
    document.getElementById('board').textContent = 'data.js did not load: open the page beside it.';
    return;
  }
  // The board the model ranks, and the protocols whose token already trades, carried as context.
  DATA.all = (DATA.rows || []).concat(DATA.context || []);

  var PAGE = 60;
  var state = {
    q: '',
    category: 'all',
    chain: 'all',
    tier: 'board',
    sort: 'rank',
    dir: 1,
    shown: PAGE,
    selected: null,
  };

  /* -------------------------------------------------------------- formatting */

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  var num = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function exact(n) {
    return n === null || n === undefined ? 'n/a' : usd.format(n);
  }
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'not reported';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function pctClass(n) {
    if (n === null || n === undefined) return 'flat';
    return n > 0.5 ? 'up' : n < -0.5 ? 'down' : 'flat';
  }
  function years(n) {
    if (n === null || n === undefined) return 'unknown';
    if (n >= 1) return n.toFixed(1) + 'y';
    return Math.round(n * 12) + 'mo';
  }
  function chainsText(row) {
    if (!row.chains || row.chains.length === 0) return '—';
    if (row.chains.length <= 3) return row.chains.join(', ');
    return row.chains.slice(0, 2).join(', ') + ' +' + (row.chains.length - 2);
  }
  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === 'class') node.className = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /* -------------------------------------------------------------- the model, re-checked here */

  // The page rebuilds a row's implied value from the snapshot fields it carries and the fitted
  // weights in DATA.model, then compares it with the number board.json holds. If the two ever
  // disagree, the page says so on the row instead of hiding it.
  function recompute(row) {
    var m = DATA.model;
    var mean = m.feature_mean;
    var scale = m.feature_scale;
    var raw = [
      Math.log10(Math.max(1, row.tvl_usd)),
      Math.min(m.growth_clip[1], Math.max(m.growth_clip[0], row.change_7d === null ? 0 : row.change_7d)) / 100,
      Math.log10(1 + (row.tenure_years || 0)),
      Math.log10(1 + Math.max(1, row.chains ? row.chains.length : 1)),
    ];
    var log10 = m.intercept + m.core * ((raw[0] - mean[0]) / scale[0]);
    for (var i = 0; i < 3; i++) log10 += m.tilt[i] * ((raw[i + 1] - mean[i + 1]) / scale[i + 1]);
    return Math.max(1, Math.round(Math.pow(10, log10)));
  }

  /* -------------------------------------------------------------- the masthead */

  function renderMast() {
    var v = DATA.validation || {};
    var a = v.A_value_model || {};
    var b = v.B_external_launches || {};
    var ab = v.A_ablation_tvl_only_walk_forward || {};

    var stamp = document.getElementById('stamp');
    [
      ['board rows', num.format(DATA.rows.length) + ' pre-token'],
      ['snapshot', num.format(DATA.universe) + ' protocols read'],
      ['watchlist', DATA.watchlist_covered + ' of ' + DATA.watchlist_total + ' covered'],
      ['as of', DATA.as_of],
    ].forEach(function (pair) {
      stamp.appendChild(el('div')).appendChild(el('dt', null, pair[0]));
      stamp.lastChild.appendChild(el('dd', null, pair[1]));
    });

    var bits = [
      ['fitted core', DATA.model.core_coefficient_per_decade_tvl.toFixed(3) + ' decades of value per decade of TVL'],
      ['walk-forward', a.folds + ' folds, rank IC ' + a.walk_forward_spearman_ic],
      ['out of sample', 'MAE ' + a.walk_forward_mae_multiple + '\u00d7 on a dollar value'],
      ['90% band', 'covered ' + (a.interval_coverage_90 * 100).toFixed(1) + '% of held-out rows'],
      ['TVL alone', 'MAE ' + ab.walk_forward_mae_multiple + '\u00d7, IC ' + ab.walk_forward_spearman_ic],
      ['slope forced to 1', 'MAE ' + ((v.A_ablation_slope_forced_to_one || {}).walk_forward_mae_multiple || 'n/a') + '\u00d7: the fitted slope is better'],
      ['external check', b.corpus_collected + ' real launches, rank IC ' + b.walk_forward_spearman_ic],
    ];
    var list = document.getElementById('method');
    bits.forEach(function (pair) {
      var li = el('li');
      li.appendChild(el('span', null, pair[0] + ' '));
      li.appendChild(el('b', null, pair[1]));
      list.appendChild(li);
    });

    document.getElementById('formula').textContent = DATA.model.formula + ' — fitted weights: a1 = ' +
      DATA.model.core_coefficient_per_decade_tvl.toFixed(3) + ' per decade of TVL, tilts [' +
      DATA.model.tilt_coefficients.map(function (t) { return t.toFixed(4); }).join(', ') + '].';
    document.getElementById('asof').textContent = DATA.as_of + ' (' + DATA.source + ')';
  }

  /* -------------------------------------------------------------- filters */

  var TABS = [
    ['board', 'ranked pre-token board', 'the protocols that record no token, ranked by implied value'],
    ['watchlist', 'watchlist', 'the snapshot watchlist: no token recorded, above the floor, no wrapped or staked product'],
    ['pre-token', 'pre-token, off-list', 'above the floor and records no token, but the watchlist rule left it out'],
    ['early', 'early', 'records no token and sits below the watchlist floor'],
    ['product', 'wrapped / staked product', 'context only: the snapshot rule reads it as a product of a token that already trades, not a launch'],
    ['live', 'token already trades', 'context only: DefiLlama records a token and a market cap'],
    ['everything', 'everything scored', 'every protocol the snapshot holds'],
  ];

  function profile() {
    var n = { board: DATA.rows.length, everything: DATA.all.length, context: DATA.context.length };
    DATA.all.forEach(function (r) { n[r.tier] = (n[r.tier] || 0) + 1; });
    return n;
  }

  /** The rows the current tab draws from. */
  function pool() {
    if (state.tier === 'board') return DATA.rows;
    if (state.tier === 'everything') return DATA.all;
    return DATA.all.filter(function (r) { return r.tier === state.tier; });
  }

  function optionsFor(key) {
    var seen = {};
    DATA.all.forEach(function (row) {
      if (key === 'chain') (row.chains || []).forEach(function (c) { seen[c] = true; });
      else if (row[key]) seen[row[key]] = true;
    });
    return Object.keys(seen).sort(function (a, b) { return a.localeCompare(b); });
  }

  function fillSelects() {
    var cat = document.getElementById('category');
    optionsFor('category').forEach(function (c) { cat.appendChild(el('option', { value: c }, c)); });
    var chain = document.getElementById('chain');
    optionsFor('chain').forEach(function (c) { chain.appendChild(el('option', { value: c }, c)); });

    var counts = profile();
    var tabs = document.getElementById('tabs');
    TABS.forEach(function (triple) {
      if (triple[0] === 'product') tabs.appendChild(el('span', { class: 'sep' }, '| context'));
      var b = el('button', { type: 'button', 'data-tier': triple[0], title: triple[2] });
      if (triple[0] === 'product' || triple[0] === 'live' || triple[0] === 'everything') b.className = 'ctx';
      b.appendChild(el('span', null, triple[1] + ' '));
      b.appendChild(el('b', null, num.format(counts[triple[0]] || 0)));
      b.setAttribute('aria-pressed', String(state.tier === triple[0]));
      b.addEventListener('click', function () {
        state.tier = triple[0];
        state.shown = PAGE;
        Array.prototype.forEach.call(tabs.children, function (node) {
          node.setAttribute('aria-pressed', String(node.getAttribute('data-tier') === state.tier));
        });
        render();
      });
      tabs.appendChild(b);
    });
  }

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var rows = pool().filter(function (row) {
      if (state.category !== 'all' && row.category !== state.category) return false;
      if (state.chain !== 'all' && (row.chains || []).indexOf(state.chain) === -1) return false;
      if (q) {
        var hay = (row.name + ' ' + (row.category || '') + ' ' + row.slug + ' ' + (row.chains || []).join(' ')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    var key = state.sort;
    var dir = state.dir;
    rows.sort(function (a, b) {
      if (key === 'name') return a.name.localeCompare(b.name) * dir;
      var av = key === 'rank' ? a.rank : a[key];
      var bv = key === 'rank' ? b.rank : b[key];
      if (av === null || av === undefined) av = -Infinity;
      if (bv === null || bv === undefined) bv = -Infinity;
      return (av - bv) * dir;
    });
    return rows;
  }

  /* -------------------------------------------------------------- the table */

  function render() {
    var rows = visibleRows();
    var tbody = document.getElementById('tbody');
    tbody.textContent = '';

    var slice = rows.slice(0, state.shown);
    slice.forEach(function (row) {
      var tr = el('tr', { 'data-slug': row.slug, tabindex: '0' });
      if (state.selected === row.slug) tr.setAttribute('aria-selected', 'true');

      tr.appendChild(el('td', { class: 'num rk' }, row.rank === null ? 'context' : row.rank));
      var name = el('td');
      name.appendChild(el('span', { class: 'pname' }, row.name));
      name.appendChild(el('small', { class: 'slug' }, row.slug));
      tr.appendChild(name);
      tr.appendChild(el('td', { class: 'chains' }, row.category || 'uncategorised'));
      tr.appendChild(el('td', { class: 'chains' }, chainsText(row)));
      tr.appendChild(el('td', { class: 'num' }, money(row.tvl_usd)));
      tr.appendChild(el('td', { class: 'num ' + pctClass(row.change_7d) }, row.change_7d === null ? '—' : pct(row.change_7d)));
      tr.appendChild(el('td', { class: 'num' }, years(row.tenure_years)));
      tr.appendChild(el('td', { class: 'num value' }, money(row.implied_value_usd)));
      var bandCell = el('td', { class: 'num bandcell' });
      var band2 = el('span', { class: 'band2' });
      band2.setAttribute('title', '90% band: ' + exact(row.implied_value_low_usd) + ' to ' + exact(row.implied_value_high_usd) + ' (±' + (DATA.model.z_90 * row.sigma_log10).toFixed(2) + ' decades)');
      band2.appendChild(el('span', { class: 'lo' }, money(row.implied_value_low_usd)));
      band2.appendChild(el('span', { class: 'hi' }, money(row.implied_value_high_usd)));
      bandCell.appendChild(band2);
      tr.appendChild(bandCell);
      var cls = el('td');
      cls.appendChild(el('span', { class: 'chip ' + row.tier }, row.tier_label));
      tr.appendChild(cls);

      tr.addEventListener('click', function () { open(row.slug); });
      tr.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(row.slug); }
      });
      tbody.appendChild(tr);
    });

    document.getElementById('counts').innerHTML = '';
    var c = document.getElementById('counts');
    c.appendChild(el('span', null, 'Showing '));
    c.appendChild(el('b', null, slice.length));
    c.appendChild(el('span', null, ' of '));
    c.appendChild(el('b', null, rows.length));
    c.appendChild(el('span', null, ' rows in this view. The board ranks '));
    c.appendChild(el('b', null, DATA.rows.length));
    c.appendChild(el('span', null, ' pre-token protocols of the '));
    c.appendChild(el('b', null, DATA.universe));
    c.appendChild(el('span', null, ' the snapshot holds, and covers '));
    c.appendChild(el('b', null, DATA.watchlist_covered + ' of ' + DATA.watchlist_total));
    c.appendChild(el('span', null, ' on the watchlist. Rank is the model\u2019s claim: rank 1 carries the largest implied value.'));

    document.getElementById('bandnote').textContent = '';
    var bn = document.getElementById('bandnote');
    bn.appendChild(el('b', null, 'On the 90% bands: '));
    bn.appendChild(el('span', null, 'a row\u2019s band is the fitted dispersion of that protocol, floored at the pooled walk-forward residual scale (' +
      DATA.model.sigma_log10.toFixed(3) + ' decades), so almost every band spans about ' +
      (2 * DATA.model.z_90 * DATA.model.sigma_log10).toFixed(1) + ' decades. That near-constant width is the finding, not a formatting choice: ' +
      'what the radar knows is where a protocol sits relative to its peers (rank IC ' + (DATA.validation.A_value_model || {}).walk_forward_spearman_ic + '), and the level itself is only pinned to about ' +
      (DATA.validation.A_value_model || {}).walk_forward_mae_multiple + '\u00d7 on a held-out protocol \u2014 ' +
      'which is why every plan here starts with money you can afford to lose.'));

    var more = document.getElementById('more');
    more.hidden = rows.length <= state.shown;
    more.textContent = 'Show more rows (' + (rows.length - state.shown) + ' left)';

    Array.prototype.forEach.call(document.querySelectorAll('th.sortable'), function (th) {
      var key = th.getAttribute('data-sort');
      if (key === state.sort) th.setAttribute('aria-sort', state.dir === 1 ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
    });
  }

  /* -------------------------------------------------------------- the detail view */

  function open(slug) {
    var row = null;
    DATA.all.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) return;
    state.selected = slug;
    render();

    var drawer = document.getElementById('drawer');
    drawer.textContent = '';
    drawer.hidden = false;

    var close = el('button', { class: 'close', type: 'button' }, 'close');
    close.addEventListener('click', function () {
      drawer.hidden = true;
      state.selected = null;
      render();
    });
    drawer.appendChild(close);

    drawer.appendChild(el('h2', null, row.name));
    drawer.appendChild(el('p', { class: 'dsub' }, row.slug + ' · ' + (row.category || 'uncategorised') + ' · ' + (row.chains || []).join(', ')));

    var verdict = el('div', { class: 'verdict' });
    verdict.appendChild(el('div', { class: 'big' }, exact(row.implied_value_usd)));
    verdict.appendChild(el('div', { class: 'sub' }, 'implied value if the record stands — 90% band ' +
      exact(row.implied_value_low_usd) + ' to ' + exact(row.implied_value_high_usd) +
      ' (\u00b1' + (DATA.model.z_90 * row.sigma_log10).toFixed(2) + ' decades, \u03c3 ' + row.sigma_log10 + ')'));
    drawer.appendChild(verdict);

    drawer.appendChild(el('p', { class: 'why' }, 'Class: ' + row.tier_label + '. ' + (row.tier === 'live'
      ? 'DefiLlama records ' + (row.symbol ? row.symbol : 'a token') + ' on this protocol: carried as context for the pre-token rows, never ranked as a launch to find.'
      : 'The snapshot records no token here (DefiLlama\u2019s record is not proof, so this row says it records none, never that it has none). ' + (row.tier_why || ''))));

    // the trace
    drawer.appendChild(el('h3', null, 'The value, taken apart'));
    var table = el('table', { class: 'trace' });
    var head = el('tr');
    ['component', 'input from the snapshot', 'fitted weight', 'z', '\u00d7', '$'].forEach(function (h) {
      head.appendChild(el('th', null, h));
    });
    table.appendChild(head);
    row.components.forEach(function (part) {
      var tr = el('tr');
      tr.appendChild(el('td', null, part.name));
      tr.appendChild(el('td', { class: 'origin' }, part.input));
      tr.appendChild(el('td', { class: 'num' }, part.fitted_weight.toFixed(4)));
      tr.appendChild(el('td', { class: 'num' }, part.standardised.toFixed(2)));
      tr.appendChild(el('td', { class: 'num' }, part.name === 'tvl_base' ? '\u2014' : '\u00d7' + part.multiplier.toFixed(4)));
      tr.appendChild(el('td', { class: 'num' }, money(part.contribution_usd)));
      table.appendChild(tr);
    });
    var foot = el('tr');
    foot.appendChild(el('td', null, 'implied value'));
    foot.appendChild(el('td', { class: 'origin' }, 'product of the multipliers above, on the base'));
    foot.appendChild(el('td'));
    foot.appendChild(el('td'));
    foot.appendChild(el('td'));
    foot.appendChild(el('td', { class: 'num' }, money(row.implied_value_usd)));
    var tfoot = el('tfoot');
    tfoot.appendChild(foot);
    table.appendChild(tfoot);
    drawer.appendChild(table);

    var check = recompute(row);
    drawer.appendChild(el('p', { class: 'why' },
      'Read back from the page: this row\u2019s snapshot fields through the same fitted weights give ' + exact(check) +
      ', against the board\u2019s ' + exact(row.implied_value_usd) + '. ' +
      (Math.abs(check - row.implied_value_usd) <= Math.max(2, row.implied_value_usd * 0.001)
        ? 'They agree, so the number on the board is this arithmetic and nothing else.'
        : 'They differ by more than rounding: treat the board\u2019s number as the one under review.')));

    // where each component comes from
    drawer.appendChild(el('h3', null, 'Where each number comes from'));
    var ul = el('ul', { class: 'origins' });
    row.components.forEach(function (part) {
      ul.appendChild(el('li', { class: 'origin' }, part.name + ': ' + part.origin));
    });
    drawer.appendChild(ul);

    // the record
    drawer.appendChild(el('h3', null, 'The record it was read from'));
    var dl = el('dl', { class: 'facts' });
    [
      ['TVL', exact(row.tvl_usd) + ' on ' + (row.chains || []).length + ' chain(s)'],
      ['7-day TVL change', pct(row.change_7d)],
      ['DefiLlama began tracking', (row.listed_at || 'not reported') + ' (' + years(row.tenure_years) + ' with no token recorded)'],
      ['market cap on record', row.records_token ? money(row.market_cap_usd) : 'none recorded'],
      ['on the watchlist', row.on_watchlist ? 'yes' : 'no'],
      ['board rank', row.rank === null ? 'context row: its token already trades, so the board does not rank it' : row.rank + ' of ' + DATA.rows.length],
    ].forEach(function (pair) {
      dl.appendChild(el('dt', null, pair[0]));
      dl.appendChild(el('dd', null, pair[1]));
    });
    drawer.appendChild(dl);

    drawer.appendChild(el('h3', null, 'How to farm it'));
    var ol = el('ol', { class: 'plan' });
    row.farm_steps.forEach(function (step) { ol.appendChild(el('li', null, step)); });
    drawer.appendChild(ol);
  }

  /* -------------------------------------------------------------- wire the controls */

  document.getElementById('q').addEventListener('input', function (ev) {
    state.q = ev.target.value;
    state.shown = PAGE;
    render();
  });
  document.getElementById('category').addEventListener('change', function (ev) {
    state.category = ev.target.value;
    state.shown = PAGE;
    render();
  });
  document.getElementById('chain').addEventListener('change', function (ev) {
    state.chain = ev.target.value;
    state.shown = PAGE;
    render();
  });
  document.getElementById('sort').addEventListener('change', function (ev) {
    state.sort = ev.target.value;
    state.dir = ev.target.value === 'rank' ? 1 : -1;
    render();
  });
  document.getElementById('more').addEventListener('click', function () {
    state.shown += PAGE * 2;
    render();
  });
  Array.prototype.forEach.call(document.querySelectorAll('th.sortable'), function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      if (state.sort === key) state.dir = -state.dir;
      else {
        state.sort = key;
        state.dir = key === 'name' ? 1 : -1;
      }
      document.getElementById('sort').value = key === 'implied' || key === 'tvl' || key === 'growth' || key === 'tenure' || key === 'name' ? key : 'rank';
      render();
    });
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      document.getElementById('drawer').hidden = true;
      state.selected = null;
      render();
    }
  });

  renderMast();
  fillSelects();
  render();
})();
