import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { orderBySource } from './sourceOrder.js';
import './agents.css';

// Small copy-to-clipboard button, mirrors the app's existing copy affordance.
function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <button className={`ag-btn ag-copy ${copied ? 'ag-ok' : ''}`} onClick={onClick} title={`Copy: ${text}`}>
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  );
}

// Launches the agent: a new macOS Terminal window for a CLI, or the desktop
// app itself for one installed as an app bundle.
function OpenTerminalBtn({ id, kind }) {
  const [state, setState] = useState(''); // '' | 'ok' | 'err'
  const app = kind === 'app';
  const onClick = async () => {
    try {
      const r = await fetch('/api/agents/open?id=' + encodeURIComponent(id));
      setState(r.ok ? 'ok' : 'err');
    } catch {
      setState('err');
    }
    setTimeout(() => setState(''), 1400);
  };
  return (
    <button
      className={`ag-btn ag-term ${state === 'ok' ? 'ag-ok' : state === 'err' ? 'ag-err' : ''}`}
      onClick={onClick}
      title={app ? 'Launch this desktop app' : 'Open a new Terminal window running this agent'}
    >
      {state === 'ok'
        ? '✓ Opened'
        : state === 'err'
          ? '✗ Failed'
          : app
            ? '⇱ Open app'
            : '⎋ Open in Terminal'}
    </button>
  );
}

// Runs the registry update command for this agent and surfaces the output.
function UpdateBtn({ id, command, onDone }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null); // { ok, output }
  const [open, setOpen] = useState(false);

  const onClick = async () => {
    if (running) return;
    setRunning(true);
    setResult(null);
    try {
      const r = await fetch('/api/agents/update?id=' + encodeURIComponent(id));
      const body = await r.json().catch(() => ({ ok: false, output: 'Bad response' }));
      setResult(body);
      setOpen(true);
    } catch (e) {
      setResult({ ok: false, output: String(e) });
      setOpen(true);
    } finally {
      setRunning(false);
      // Even a failed update may have changed the install; show what's there now.
      onDone();
    }
  };

  return (
    <div className="ag-update-wrap">
      <button
        className={`ag-btn ag-update ${running ? 'ag-running' : ''}`}
        onClick={onClick}
        disabled={running}
        title={`Run: ${command}`}
      >
        {running ? (
          <>
            <span className="ag-spinner" /> Updating…
          </>
        ) : (
          '↑ Update'
        )}
      </button>
      {result && (
        <div className={`ag-result ${result.ok ? 'ag-result-ok' : 'ag-result-err'}`}>
          <button className="ag-result-head" onClick={() => setOpen((v) => !v)}>
            <span className="ag-result-status">
              {result.ok ? '✓ Update finished' : '✗ Update failed'}
            </span>
            <span className="ag-result-toggle">{open ? '▲ hide output' : '▼ show output'}</span>
          </button>
          {open && <pre className="ag-result-out">{result.output || '(no output)'}</pre>}
        </div>
      )}
    </div>
  );
}

function Exists({ ok }) {
  return <span className={`ag-exists ${ok ? 'ag-yes' : 'ag-no'}`}>{ok ? '✓' : '✗'}</span>;
}

function AgentCard({ a, onUpdated }) {
  return (
    <div className={`ag-card ${a.installed ? '' : 'ag-card-off'}`}>
      <div className="ag-card-head">
        <span className="ag-name">{a.label}</span>
        <span className={`ag-badge ${a.installed ? 'ag-badge-on' : 'ag-badge-off'}`}>
          {a.installed ? 'installed' : 'not installed'}
        </span>
        {a.conversationCount > 0 && (
          <span className="ag-count" title="Conversations from this tool">
            {a.conversationCount} convos
          </span>
        )}
      </div>

      <div className="ag-rows">
        {a.installed && a.version && (
          <div className="ag-row">
            <span className="ag-key">Version</span>
            <span className="ag-val">{a.version}</span>
          </div>
        )}
        {a.installed && a.path && (
          <div className="ag-row">
            <span className="ag-key">{a.kind === 'app' ? 'App' : 'Binary'}</span>
            <code className="ag-val ag-mono">{a.path}</code>
          </div>
        )}
        <div className="ag-row">
          <span className="ag-key">Config dir</span>
          <span className="ag-val">
            <Exists ok={a.configDirExists} /> <code className="ag-mono">{a.configDir}</code>
          </span>
        </div>
        <div className="ag-row">
          <span className="ag-key">Config file</span>
          <span className="ag-val">
            {a.configFile ? (
              <>
                <Exists ok={a.configFileExists} /> <code className="ag-mono">{a.configFile}</code>
              </>
            ) : (
              <span className="ag-muted">none well-known</span>
            )}
          </span>
        </div>
      </div>

      <div className="ag-cmd-line">
        <code className="ag-cmd">{a.runCommand}</code>
        <div className="ag-cmd-actions">
          <CopyBtn text={a.runCommand} />
          {a.installed && <OpenTerminalBtn id={a.id} kind={a.kind} />}
        </div>
      </div>

      {a.updateCommand && a.installed && <UpdateBtn id={a.id} command={a.updateCommand} onDone={onUpdated} />}
    </div>
  );
}

// The panel unmounts whenever it's hidden, so the last payload lives at module
// scope: reopening renders it immediately and revalidates in the background
// instead of showing the probing state again. The server caches the expensive
// parts (login-shell PATH, per-binary version probes), so a revalidate is cheap.
let lastAgents = null;
// The header Refresh count this module last acted on, so a press made while
// the panel was hidden still forces a re-probe on the next open.
let seenRefreshKey = 0;
// Request ids are globally increasing. Each panel instance applies only its
// own newest request to its state; the module cache keeps the newest response
// from any instance. Either way an older request finishing late (e.g. the
// mount load landing after a post-Update re-probe) can't roll data back.
let requestSeq = 0;
let cachedSeq = 0;

// Registry agent ids are the same ids as the conversation sources, so the
// cards can follow the header chips exactly like the usage cards do. `counts`
// is App's [source, n] list — derived from the blocklist-filtered conversation
// list, so these numbers always agree with the main list. `refreshKey` changes
// when the user presses the header Refresh, which forces a full re-probe.
export default function Agents({ order, counts, refreshKey = 0 }) {
  const [agents, setAgents] = useState(lastAgents);
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
    fetch('/api/agents' + (refresh ? '?refresh=1' : ''))
      .then((r) => {
        if (!r.ok) throw new Error(`agents ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (d && d.error) throw new Error(String(d.error));
        const list = Array.isArray(d) ? d : [];
        if (id > cachedSeq) {
          cachedSeq = id;
          lastAgents = list;
        }
        if (id === latest.current && mounted.current) {
          setAgents(list);
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

  const withCounts = useMemo(() => {
    if (!agents) return null;
    const byId = new Map(counts);
    return agents.map((a) => ({ ...a, conversationCount: byId.get(a.id) || 0 }));
  }, [agents, counts]);

  const installedCount = agents ? agents.filter((a) => a.installed).length : 0;

  return (
    <section className="ag-wrap">
      <div className="ag-panel-head">
        <span className="ag-panel-title">AI coding agents</span>
        {agents && (
          <span className="ag-panel-sub">
            {installedCount} of {agents.length} installed
            {loading && ' · checking…'}
            {!loading && error && (
              <span className="ag-stale" title={error}>
                {' '}
                · refresh failed, showing last known
              </span>
            )}
          </span>
        )}
      </div>

      {error && !agents && <div className="ag-state ag-state-err">Agents unavailable ({error})</div>}
      {!agents && !error && <div className="ag-state">Probing installed agents…</div>}

      {withCounts && (
        <div className="ag-grid">
          {orderBySource(withCounts, order, (a) => a.id).map((a) => (
            <AgentCard key={a.id} a={a} onUpdated={() => load(true)} />
          ))}
        </div>
      )}
    </section>
  );
}
