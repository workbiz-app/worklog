/* Worklog sync v4: deterministic field merge with explicit deletion records.
 * Each browser writes its own Drive replica; no shared-file overwrite is needed.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorklogSyncCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  function hash(value) {
    const text = typeof value === 'string' ? value : stable(value);
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
    return (a >>> 0).toString(36) + '-' + (b >>> 0).toString(36);
  }
  function normalize(value) {
    if (Array.isArray(value)) {
      const seen = new Map();
      return value.map(item => {
        const v = normalize(item);
        if (v && typeof v === 'object' && !Array.isArray(v) && v.id == null && !v._syncId) {
          const h = hash(v), n = seen.get(h) || 0; seen.set(h, n + 1);
          v._syncId = 'legacy-' + h + '-' + n;
        }
        return v;
      });
    }
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (k !== '_syncV4' && k !== '__proto__' && k !== 'constructor' && k !== 'prototype') out[k] = normalize(v);
      }
      return out;
    }
    return value;
  }
  function flatten(state) {
    const out = Object.create(null);
    function visit(v, path) {
      const key = JSON.stringify(path);
      // Calculators store JSON inside localStorage strings. Merge the records inside
      // these strings too, then restore the exact storage format on materialization.
      if (path[0] === 'calculatorData' && path.length === 3 && typeof v === 'string') {
        try { const parsed = JSON.parse(v); out[key] = {kind:'json'}; visit(normalize(parsed), [...path, '$json']); return; } catch (_) {}
      }
      if (Array.isArray(v)) {
        const seen = new Map();
        const keys = v.map(item => {
          const base = item && typeof item === 'object' && !Array.isArray(item)
            ? 'id:' + String(item.id ?? item._syncId ?? hash(item)) : 'value:' + hash(item);
          const n = seen.get(base) || 0; seen.set(base, n + 1);
          return base + (n ? ':duplicate:' + n : '');
        });
        out[key] = {kind:'array', order:keys};
        v.forEach((item, i) => visit(item, [...path, keys[i]]));
      } else if (v && typeof v === 'object') {
        out[key] = {kind:'object'};
        Object.keys(v).sort().forEach(k => visit(v[k], [...path, k]));
      } else { out[key] = {kind:'value', value:v}; }
    }
    visit(normalize(state), []);
    return out;
  }
  function materialize(nodes, meta) {
    const children = new Map();
    for (const key of Object.keys(nodes)) {
      const path = JSON.parse(key);
      if (!path.length) continue;
      const parent = JSON.stringify(path.slice(0, -1));
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent).add(path[path.length - 1]);
    }
    function read(path) {
      const key = JSON.stringify(path), n = nodes[key];
      if (!n || meta[key]?.deleted) return undefined;
      if (n.kind === 'value') return n.value;
      if (n.kind === 'json') return JSON.stringify(read([...path, '$json']));
      const keys = [...(children.get(key) || [])].sort();
      if (n.kind === 'array') {
        const order = [...new Set([...(n.order || []), ...keys])];
        return order.map(k => read([...path, k])).filter(v => v !== undefined);
      }
      const out = {};
      for (const k of keys) {
        if (['__proto__','constructor','prototype'].includes(k)) continue;
        const v = read([...path, k]); if (v !== undefined) out[k] = v;
      }
      return out;
    }
    return read([]) || {};
  }
  // Generation 0 = legacy import. Explicit v4 edits/deletions always beat old
  // snapshots, including an old browser tab that uploads its whole file again.
  function compare(a, b) {
    a = a || [0,0,'']; b = b || [0,0,''];
    return a[0] - b[0] || a[1] - b[1] || String(a[2]).localeCompare(String(b[2]), 'en');
  }
  function fromLegacy(state, time = 0, actor = 'legacy') {
    const clean = normalize(state), nodes = flatten(clean), meta = Object.create(null);
    for (const [key, n] of Object.entries(nodes)) {
      const empty = n.kind !== 'value' || n.value === '' || n.value == null;
      meta[key] = {stamp:[0, empty ? 0 : Number(time) || 0, actor]};
    }
    return {state:materialize(nodes, meta), meta};
  }
  function restore(state) {
    const saved = state?._syncV4;
    if (!saved?.meta) return null;
    return {state:normalize(state), meta:clone(saved.meta)};
  }
  function change(doc, state, actor, now = Date.now()) {
    const before = flatten(doc.state), after = flatten(state), meta = clone(doc.meta);
    const clock = Object.values(meta).reduce((n,m) => Math.max(n, Number(m.stamp?.[1]) + 1 || 0), now);
    let changed = false;
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (stable(before[key]) === stable(after[key])) continue;
      meta[key] = {stamp:[1,clock,actor], ...(after[key] ? {} : {deleted:true})};
      changed = true;
    }
    return changed ? {state:materialize(after,meta),meta} : doc;
  }
  function merge(a, b) {
    const an = flatten(a.state), bn = flatten(b.state), nodes = Object.create(null), meta = Object.create(null);
    for (const key of new Set([...Object.keys(a.meta), ...Object.keys(b.meta)])) {
      const am = a.meta[key], bm = b.meta[key];
      let takeB = !am || (bm && compare(bm.stamp, am.stamp) > 0);
      if (am && bm && compare(bm.stamp,am.stamp) === 0) {
        // Stable tie-breaker for legacy values; no dependence on download order.
        takeB = stable([bm,bn[key] ?? null]) > stable([am,an[key] ?? null]);
      }
      const m = takeB ? bm : am, n = takeB ? bn[key] : an[key];
      if (!m) continue;
      meta[key] = clone(m); if (n && !m.deleted) nodes[key] = clone(n);
    }
    const state = materialize(nodes,meta);
    // Keep metadata for tombstones, but discard invisible descendants' values.
    return {state,meta};
  }
  function equal(a,b) { return stable(a) === stable(b); }
  function signature(doc) { return hash(stable(doc)); }
  function envelope(doc, extra = {}) { return {...clone(doc.state), _syncV4:{...extra, meta:clone(doc.meta)}}; }
  return {clone,stable,hash,normalize,flatten,materialize,compare,fromLegacy,restore,change,merge,equal,signature,envelope};
});
