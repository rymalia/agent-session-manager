import { useCallback, useEffect, useRef, useState } from 'react';
import { orderBySource } from './sourceOrder.js';
import './usage.css';

// Fallback source metadata; replaced by /api/sources on load. Mirrors the
// shape served by the conversations API so colours/labels stay consistent.
const DEFAULT_META = {
  claude: { label: 'Claude Code', short: 'Claude', color: '#d97757' },
  codex: { label: 'Codex', short: 'Codex', color: '#10a37f' },
  grok: { label: 'Grok', short: 'Grok', color: '#9b87f5' },
  opencode: { label: 'opencode', short: 'opencode', color: '#f0883e' },
  cursor: { label: 'Cursor', short: 'Cursor', color: '#4d9fff' },
  gemini: { label: 'Gemini CLI', short: 'Gemini', color: '#e6477f' },
  kimi: { label: 'Kimi Code', short: 'Kimi', color: '#22d3ee' },
  antigravity: { label: 'Antigravity CLI', short: 'Antigravity', color: '#6366f1' },
};

const KIND_TAG = {
  quota: 'quota left',
  consumed: 'used',
  activity: 'activity',
};

// The panel unmounts whenever it's hidden, so keep the last payload and source
// metadata at module scope: reopening renders them immediately and revalidates
// in the background instead of showing the loading state again.
let lastUsage = null;
let lastSourcesMeta = null;
// The header Refresh count this module last acted on, so a press made while
// the panel was hidden still forces a fresh usage build on the next open.
let seenRefreshKey = 0;
// Request ids are globally increasing. Each panel instance applies only its
// own newest request to its state; the module cache keeps the newest response
// from any instance so a late response can't roll data back.
let requestSeq = 0;
let cachedSeq = 0;
let pendingRefresh = null;

// A metric that represents a percentage of remaining quota gets a small bar.
function isPercent(m) {
  return /^(limit_|quota)/.test(m.key) || (typeof m.value === 'number' && /%$/.test(m.display || ''));
}

function Metric({ m, accent }) {
  return (
    <div className="usg-metric">
      <div className="usg-metric-row">
        <span className="usg-metric-label">{m.label}</span>
        <span className="usg-metric-value">{m.display ?? '—'}</span>
      </div>
      {isPercent(m) && typeof m.value === 'number' && (
        <div className="usg-bar">
          <div
            className="usg-bar-fill"
            style={{ width: `${Math.max(0, Math.min(100, m.value))}%`, background: accent }}
          />
        </div>
      )}
      {m.detail && <span className="usg-metric-detail">{m.detail}</span>}
    </div>
  );
}

function Card({ entry, meta }) {
  const m = meta[entry.source] || {};
  const accent = m.color || 'var(--accent)';
  const name = m.label || entry.label || entry.source;
  const style = { '--usg-accent': accent };

  if (!entry.available) {
    return (
      <div className="usg-card usg-off" style={style}>
        <div className="usg-card-head">
          <span className="usg-dot" />
          <span className="usg-name">{name}</span>
          <span className="usg-tag">n/a</span>
        </div>
        <div className="usg-na">
          <span className="usg-na-dash">—</span>
        </div>
        <div className="usg-note">{entry.note || 'No local usage data'}</div>
      </div>
    );
  }

  const tag = KIND_TAG[entry.kind] || 'used';
  return (
    <div className="usg-card" style={style}>
      <div className="usg-card-head">
        <span className="usg-dot" />
        <span className="usg-name">{name}</span>
        <span className={`usg-tag ${entry.kind === 'quota' ? 'usg-tag-quota' : ''}`}>{tag}</span>
      </div>
      <div className="usg-metrics">
        {(entry.metrics || []).map((metric) => (
          <Metric key={metric.key} m={metric} accent={accent} />
        ))}
      </div>
      {entry.note && <div className="usg-note">{entry.note}</div>}
    </div>
  );
}

export default function Usage({ order, refreshKey = 0 }) {
  const [data, setData] = useState(lastUsage);
  const [meta, setMeta] = useState(lastSourcesMeta || DEFAULT_META);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Responses still update the module cache after the panel closes; only the
  // React state writes are skipped.
  const mounted = useRef(false);
  const latest = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback((refresh) => {
    const id = ++requestSeq;
    latest.current = id;
    setLoading(true);
    // A plain load joins a pending refresh: the server would answer it at once
    // from its older snapshot, and as the newer request it would win.
    const request = !refresh && pendingRefresh
      ? pendingRefresh
      : Promise.all([
          fetch('/api/usage' + (refresh ? '?refresh=1' : '')).then((r) => {
            if (!r.ok) throw new Error(`usage ${r.status}`);
            return r.json();
          }),
          fetch('/api/sources').then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]);
    if (refresh) {
      pendingRefresh = request;
      const clear = () => { if (pendingRefresh === request) pendingRefresh = null; };
      request.then(clear, clear);
    }
    request
      .then(([usage, sources]) => {
        const list = Array.isArray(usage) ? usage : [];
        if (id > cachedSeq) {
          cachedSeq = id;
          lastUsage = list;
          if (sources && typeof sources === 'object') lastSourcesMeta = sources;
        }
        if (id === latest.current && mounted.current) {
          setData(list);
          if (sources && typeof sources === 'object') setMeta(sources);
          setError(null);
        }
      })
      .catch((e) => {
        if (id === latest.current && mounted.current) setError(e.message || 'failed to load');
      })
      .finally(() => {
        if (id === latest.current && mounted.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    const force = refreshKey !== seenRefreshKey;
    seenRefreshKey = refreshKey;
    load(force);
  }, [load, refreshKey]);

  const available = (data || []).filter((d) => d.available).length;

  return (
    <section className="usg-wrap">
      <div className="usg-head">
        <span className="usg-title">Usage &amp; quota</span>
        {data && (
          <span className="usg-sub">
            {available} of {data.length} tools expose local data
            {loading && ' · checking…'}
            {!loading && error && (
              <span className="usg-stale" title={error}>
                {' '}
                · refresh failed, showing last known
              </span>
            )}
          </span>
        )}
      </div>

      {!data && loading && <div className="usg-state">Loading usage…</div>}
      {!data && !loading && error && <div className="usg-state">Usage unavailable ({error})</div>}
      {!loading && !error && data && data.length === 0 && (
        <div className="usg-state">No usage data</div>
      )}

      {data && data.length > 0 && (
        <div className="usg-grid">
          {orderBySource(data, order).map((entry) => (
            <Card key={entry.source} entry={entry} meta={meta} />
          ))}
        </div>
      )}
    </section>
  );
}
