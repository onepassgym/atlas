import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Activity, AlertTriangle, Cpu, Gauge, Globe2, Layers, RefreshCw, Search, ShieldAlert, Zap, Database, Clock,
} from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';

// ── Formatting helpers ───────────────────────────────────────────────────────

const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString());
const fmtMs = (ms) => {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
};
const fmtUptime = (s) => fmtMs((s || 0) * 1000);
const ago = (iso) => (iso ? `${fmtMs(Date.now() - new Date(iso).getTime())} ago` : 'never');
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

const ROLE_META = {
  'crawl-worker':      { label: 'Crawl worker',      icon: Search },
  'chain-worker':      { label: 'Chain worker',      icon: Layers },
  'enrichment-worker': { label: 'Enrichment worker', icon: Zap },
};

// Outcome → status tone. Tones map onto the dashboard's reserved status tokens
// and always render with a text label, never color alone.
const OUTCOME_TONE = {
  created: 'good', updated: 'good', enriched: 'good', found: 'good',
  skipped: 'neutral', unchanged: 'neutral', empty: 'neutral', irrelevant: 'neutral',
  failed: 'bad', error: 'bad', blocked: 'bad',
};

const PHASE_TONE = {
  scraping: 'active', searching: 'active', saving: 'active', google_maps: 'active', website: 'active', crawling: 'active',
  'throttle-wait': 'neutral', 'between-records': 'neutral', idle: 'neutral', paused: 'warn', 'human-pause': 'neutral',
  'block-cooldown': 'bad', cooldown: 'bad',
};

// Merge polled snapshots with fresher SSE heartbeats (same instance key).
function mergeWorkers(polled = [], live = {}) {
  const byId = new Map(polled.map(w => [w.instance, w]));
  for (const [id, hb] of Object.entries(live)) {
    if (Date.now() - hb.receivedAt > 20_000) continue; // expired heartbeat
    byId.set(id, hb);
  }
  return [...byId.values()].sort((a, b) => a.role.localeCompare(b.role) || a.instance.localeCompare(b.instance));
}

// ── Small building blocks ────────────────────────────────────────────────────

function Kpi({ icon: Icon, label, value, sub, tone }) {
  return (
    <div className={`card pl-kpi ${tone ? `pl-kpi-${tone}` : ''}`}>
      <div className="pl-kpi-label"><Icon size={14} /> {label}</div>
      <div className="pl-kpi-value">{value}</div>
      {sub && <div className="pl-kpi-sub">{sub}</div>}
    </div>
  );
}

function OutcomeChips({ counts = {} }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return <span className="pl-muted">no activity in window</span>;
  return (
    <div className="pl-chips">
      {entries.map(([k, v]) => (
        <span key={k} className={`pl-chip pl-tone-${OUTCOME_TONE[k] || 'neutral'}`}>
          <span className="pl-dot" />{k} <b>{v}</b>
        </span>
      ))}
    </div>
  );
}

function MeterLine({ label, m }) {
  if (!m) return null;
  return (
    <div className="pl-meter">
      <div className="pl-meter-head">
        <span className="pl-meter-label">{label}</span>
        <span className="pl-mono">{m.perMin}/min · p50 {fmtMs(m.p50Ms)} · p95 {fmtMs(m.p95Ms)}</span>
      </div>
      <OutcomeChips counts={m.counts} />
    </div>
  );
}

function ActivityTable({ rows = [] }) {
  if (!rows.length) return <div className="pl-muted pl-pad">No active pages / lanes</div>;
  return (
    <div className="pl-table-wrap">
      <table className="pl-table">
        <thead><tr><th>Slot</th><th>Phase</th><th>Working on</th><th>Where</th><th>For</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.slot}>
              <td className="pl-mono pl-muted">{r.slot.replace(/^pool\d+:/, '')}</td>
              <td><span className={`pl-chip pl-tone-${PHASE_TONE[r.phase] || 'neutral'}`}><span className="pl-dot" />{r.phase}</span></td>
              <td className="pl-target" title={r.target}>
                {r.target || '—'}
                {r.index != null && r.total != null && <span className="pl-muted"> · {r.index + 1}/{r.total}</span>}
                {r.priority && <span className="pl-chip pl-tone-warn" style={{ marginLeft: 6 }}>priority</span>}
              </td>
              <td className="pl-muted">{r.city || r.area || '—'}</td>
              <td className={`pl-mono ${r.forMs > 120_000 && PHASE_TONE[r.phase] === 'active' ? 'pl-text-bad' : ''}`}>{fmtMs(r.forMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorkerCard({ w }) {
  const meta = ROLE_META[w.role] || { label: w.role, icon: Cpu };
  const Icon = meta.icon;
  const hbAge = w.at ? Date.now() - new Date(w.at).getTime() : null;
  const stale = hbAge != null && hbAge > 15_000;
  return (
    <div className="card pl-worker">
      <div className="pl-worker-head">
        <div className="pl-worker-title"><Icon size={16} /> {meta.label}</div>
        <span className={`badge-status ${stale ? 'failed' : w.state === 'busy' || w.state === 'running' ? 'running' : w.state === 'paused' ? 'queued' : 'completed'}`}>
          {stale ? 'no heartbeat' : w.state || 'up'}
        </span>
      </div>
      <div className="pl-worker-meta pl-mono">
        {w.instance} · up {fmtUptime(w.uptimeSec)} · {w.rssMb}MB RSS · load {w.load1} · beat {fmtMs(hbAge)} ago
      </div>

      {w.role === 'crawl-worker' && (
        <>
          <MeterLine label="Place pages (5 min)" m={w.scrape} />
          <MeterLine label="Category searches (5 min)" m={w.search} />
          {w.throttles?.length > 0 && (
            <div className="pl-chips" style={{ marginBottom: 10 }}>
              {w.throttles.map((t, i) => (
                <span key={i} className={`pl-chip pl-tone-${t.tripped ? 'bad' : t.multiplier > 1.5 ? 'warn' : 'neutral'}`}>
                  <span className="pl-dot" />throttle {t.city}: {t.multiplier.toFixed(2)}×{t.tripped ? ' TRIPPED' : ''}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {w.role === 'enrichment-worker' && (
        <>
          {Object.entries(w.sources || {}).map(([src, m]) => (
            <MeterLine key={src} label={`${src === 'google_maps' ? 'Google Maps' : 'Website'} (5 min)`} m={m} />
          ))}
          {w.googleCooldownMs > 0 && (
            <div className="pl-banner pl-tone-bad"><ShieldAlert size={14} /> Google source cooling down for {fmtMs(w.googleCooldownMs)} — website lanes continue</div>
          )}
          <div className="pl-muted pl-small" style={{ marginBottom: 8 }}>
            {fmtNum(w.processedToday)} processed today · {fmtNum(w.processedTotal)} since start · rotation {w.config?.rotation?.join(' → ')}
          </div>
        </>
      )}

      <ActivityTable rows={w.activity} />
    </div>
  );
}

function SourceBacklog({ name, s }) {
  if (!s) return null;
  const total = s.eligible || 0;
  const segs = [
    { key: 'fresh', label: 'Fresh', value: s.fresh, tone: 'good' },
    { key: 'due', label: 'Due now', value: s.due, tone: 'warn' },
  ];
  return (
    <div className="pl-source">
      <div className="pl-meter-head">
        <span className="pl-meter-label">{s.label || name}</span>
        <span className="pl-mono pl-muted">{fmtNum(total)} eligible · refresh every {s.refreshDays}d</span>
      </div>
      <div className="pl-stack" role="img" aria-label={`${s.label}: ${s.fresh} fresh, ${s.due} due of ${total}`}>
        {segs.filter(g => g.value > 0).map(g => (
          <div key={g.key} className={`pl-seg pl-bg-${g.tone}`} style={{ flexGrow: g.value }} title={`${g.label}: ${fmtNum(g.value)} (${pct(g.value, total)}%)`} />
        ))}
        {total === 0 && <div className="pl-seg pl-bg-neutral" style={{ flexGrow: 1 }} title="No eligible records" />}
      </div>
      <div className="pl-legend">
        {segs.map(g => (
          <span key={g.key}><span className={`pl-swatch pl-bg-${g.tone}`} />{g.label} <b>{fmtNum(g.value)}</b> <span className="pl-muted">({pct(g.value, total)}%)</span></span>
        ))}
        <span className="pl-muted">never enriched <b>{fmtNum(s.never)}</b></span>
        <span className={s.failing ? 'pl-text-bad' : 'pl-muted'}>failing (≥3 errors) <b>{fmtNum(s.failing)}</b></span>
        <span className="pl-muted">in-flight <b>{fmtNum(s.running)}</b></span>
      </div>
    </div>
  );
}

function describeEvent(e) {
  const d = e.data || {};
  switch (e.type) {
    case 'crawl:space-done':      return `${d.spaceName} → ${d.action}${d.completeness != null ? ` · ${d.completeness}% complete` : ''}${d.reason ? ` · ${d.reason}` : ''} (${fmtMs(d.duration)})`;
    case 'crawl:space-failed':    return `${decodeURIComponent(d.url || '')} — ${d.error} (attempt ${d.attempt}/${d.maxRetries})`;
    case 'crawl:search-done':     return `"${d.category}" → ${d.urlsFound} results (${d.totalUnique ?? '?'} unique)${d.error ? ` — ${d.error}` : ''}`;
    case 'crawl:batch-start':     return `${d.cityName} batch ${d.batchIndex} — ${d.urlCount} URLs`;
    case 'crawl:batch-done':      return `${d.cityName} batch ${d.batchIndex} — +${d.stats?.created || 0} new, ${d.stats?.updated || 0} updated, ${d.stats?.failed || 0} failed (${fmtMs(d.duration)})`;
    case 'crawl:block':           return `Google block — cooling down ${fmtMs(d.cooldownMs)}`;
    case 'crawl:circuit_breaker': return `Circuit breaker tripped after ${d.consecutiveFails} failures (${d.reason})`;
    case 'crawl:batch-requeued':  return `${d.count} URL(s) requeued in ${fmtMs(d.delayMs)} (${d.reason})`;
    case 'enrichment:space-done': return `[${d.source}] ${d.spaceName} → ${d.action}${d.changedFields?.length ? ` · ${d.changedFields.slice(0, 4).join(', ')}${d.changedFields.length > 4 ? '…' : ''}` : ''}${d.newReviews ? ` · +${d.newReviews} reviews` : ''}${d.newPhotos ? ` · +${d.newPhotos} photos` : ''}${d.reason ? ` · ${d.reason}` : ''}`;
    case 'enrichment:space-failed': return `[${d.source}] ${d.spaceName} — ${d.error}${d.retryInMs ? ` · retry in ${fmtMs(d.retryInMs)}` : ''}`;
    case 'enrichment:cooldown':   return d.source ? `${d.source} cooling down ${fmtMs(d.cooldownMs)} (${d.reason})` : `lane ${d.lane} cooldown after ${d.errors} errors`;
    case 'job:started':           return `${d.type} job started — ${d.cityName || d.regionName || d.spaceName || d.chainName || d.jobId}`;
    case 'job:completed':         return `Job completed — ${d.cityName || d.chainName || d.jobId} (${fmtMs(d.durationMs)})`;
    case 'job:failed':            return `Job failed — ${d.cityName || d.chainName || d.jobId}: ${d.error}`;
    default:                      return d.spaceName || d.name || d.message || d.category || '';
  }
}

const EVENT_TONE = (e) => {
  const d = e.data || {};
  if (/failed|block|circuit|cooldown/.test(e.type)) return 'bad';
  if (e.type === 'crawl:space-done' && d.action === 'irrelevant') return 'neutral';
  if (/done|completed|created/.test(e.type)) return 'good';
  return 'neutral';
};

const FEED_FILTERS = {
  all:        () => true,
  crawl:      (e) => e.type.startsWith('crawl:') || e.type.startsWith('job:'),
  enrichment: (e) => e.type.startsWith('enrichment:'),
  problems:   (e) => EVENT_TONE(e) === 'bad',
};

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Pipeline() {
  const { events, liveWorkers, connected, toast } = useApp();
  const [snap, setSnap] = useState(null);
  const [loading, setLoading] = useState(true);
  const [feedFilter, setFeedFilter] = useState('all');
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/api/system/pipeline');
      if (res?.success) setSnap(res);
    } catch (e) {
      toast?.('Failed to load pipeline snapshot', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
    const poll = setInterval(load, 5000);
    const clock = setInterval(() => setTick(t => t + 1), 1000); // keep "for"/"ago" ticking
    return () => { clearInterval(poll); clearInterval(clock); };
  }, [load]);

  const workers = useMemo(() => mergeWorkers(snap?.workers, liveWorkers), [snap, liveWorkers]);
  const aliveRoles = new Set(workers.map(w => w.role));
  const missingRoles = Object.keys(ROLE_META).filter(r => !aliveRoles.has(r));

  const crawlCounts = workers.filter(w => w.role === 'crawl-worker').reduce((acc, w) => {
    for (const [k, v] of Object.entries(w.scrape?.counts || {})) acc[k] = (acc[k] || 0) + v;
    return acc;
  }, {});
  const crawlOk = (crawlCounts.created || 0) + (crawlCounts.updated || 0) + (crawlCounts.skipped || 0) + (crawlCounts.irrelevant || 0);
  const crawlBad = (crawlCounts.failed || 0) + (crawlCounts.blocked || 0) + (crawlCounts.error || 0);
  const sum = (fn) => +workers.reduce((a, w) => a + (fn(w) || 0), 0).toFixed(1);
  const crawlPerMin = sum(w => w.scrape?.perMin);
  const enrichPerMin = sum(w => Object.values(w.sources || {}).reduce((a, m) => a + (m.perMin || 0), 0));
  const sources = snap?.enrichment?.sources || {};
  const dueTotal = Object.values(sources).reduce((a, s) => a + (s?.due || 0), 0);
  const cov = snap?.coverage || {};
  const q = snap?.queues || {};
  const pausedQueues = Object.entries(q.paused || {}).filter(([, v]) => v).map(([k]) => k);

  const feed = events.filter(FEED_FILTERS[feedFilter]).filter(e => !['crawl:space-start', 'enrichment:space-start', 'crawl:throttle'].includes(e.type)).slice(0, 80);

  if (loading && !snap) {
    return <div className="container" style={{ paddingTop: 20 }}><div className="skeleton" style={{ height: 120, marginBottom: 16 }} /><div className="skeleton" style={{ height: 320 }} /></div>;
  }

  return (
    <div className="container pl-page">
      <div className="pl-header">
        <div>
          <h1 className="pl-h1"><Activity size={22} /> Live Pipeline</h1>
          <div className="pl-muted pl-small">What every worker, page and enrichment lane is doing right now · updates every 5s{snap?.at ? ` · snapshot ${ago(snap.at)}` : ''}</div>
        </div>
        <div className="pl-header-actions">
          <span className={`pl-chip pl-tone-${connected ? 'good' : 'bad'}`}><span className="pl-dot" />{connected ? 'live stream connected' : 'live stream disconnected'}</span>
          <button className="btn sm" onClick={load}><RefreshCw size={12} /> Refresh</button>
        </div>
      </div>

      {/* ── Alerts ───────────────────────────────────────────────── */}
      {(missingRoles.length > 0 || pausedQueues.length > 0 || snap?.system?.globalPause || snap?.enrichment?.paused) && (
        <div className="pl-alerts">
          {missingRoles.map(r => (
            <div key={r} className="pl-banner pl-tone-bad"><AlertTriangle size={14} /> <b>{ROLE_META[r].label} is not running</b> — no heartbeat. Start it with <code>npm run {r === 'crawl-worker' ? 'worker' : r === 'chain-worker' ? 'worker:chain' : 'worker:enrich'}</code>.</div>
          ))}
          {pausedQueues.length > 0 && <div className="pl-banner pl-tone-warn"><AlertTriangle size={14} /> Paused queue(s): <b>{pausedQueues.join(', ')}</b> — jobs are accepted but will not run.</div>}
          {snap?.system?.globalPause && <div className="pl-banner pl-tone-warn"><AlertTriangle size={14} /> Global pause is ON{snap.system.pauseReason ? ` (${snap.system.pauseReason})` : ''}.</div>}
          {snap?.enrichment?.paused && <div className="pl-banner pl-tone-warn"><AlertTriangle size={14} /> Enrichment loop is paused.</div>}
        </div>
      )}

      {/* ── KPIs ─────────────────────────────────────────────────── */}
      <div className="pl-kpis">
        <Kpi icon={Search} label="Crawl throughput" value={`${crawlPerMin}/min`} sub={`place pages · pace ${snap?.system?.crawlPace || 'normal'}`} />
        <Kpi icon={Gauge} label="Crawl success (5 min)" value={crawlOk + crawlBad ? `${pct(crawlOk, crawlOk + crawlBad)}%` : '—'} sub={`${crawlBad} failed/blocked of ${crawlOk + crawlBad}`} tone={crawlOk + crawlBad && pct(crawlOk, crawlOk + crawlBad) < 70 ? 'bad' : null} />
        <Kpi icon={Zap} label="Enrichment throughput" value={`${enrichPerMin}/min`} sub={`${fmtNum(snap?.enrichment?.processedToday)} records today`} />
        <Kpi icon={Clock} label="Enrichment backlog" value={fmtNum(dueTotal)} sub="source × record passes due now" />
        <Kpi icon={Database} label="New spaces (24h)" value={fmtNum(cov.new24h)} sub={`${fmtNum(cov.updated24h)} updated · ${fmtNum(cov.total)} total`} />
        <Kpi icon={Layers} label="Crawl queue" value={fmtNum((q.crawl?.waiting || 0) + (q.crawl?.delayed || 0))} sub={`${q.crawl?.active || 0} active · ${q.crawl?.failed || 0} failed`} />
      </div>

      {/* ── Workers ──────────────────────────────────────────────── */}
      <div className="pl-section-title"><Cpu size={14} /> Workers</div>
      <div className="pl-workers">
        {workers.length === 0 && <div className="card pl-muted pl-pad">No worker heartbeats. Start the workers (<code>npm run dev:all</code>).</div>}
        {workers.map(w => <WorkerCard key={w.instance} w={w} />)}
      </div>

      <div className="pl-grid-2">
        {/* ── Enrichment backlog per source ───────────────────────── */}
        <div className="card">
          <div className="card-header"><span className="card-title">Enrichment schedule by source</span></div>
          {Object.keys(sources).length === 0 && <div className="pl-muted">No schedule data yet.</div>}
          {Object.entries(sources).map(([name, s]) => <SourceBacklog key={name} name={name} s={s} />)}
        </div>

        {/* ── Data coverage ───────────────────────────────────────── */}
        <div className="card">
          <div className="card-header"><span className="card-title">Data coverage</span><span className="pl-muted pl-small">of {fmtNum(cov.total)} spaces</span></div>
          {[
            ['Phone', cov.withPhone], ['Website', cov.withWebsite], ['Email', cov.withEmail],
            ['Opening hours', cov.withHours], ['Photos', cov.withPhotos],
          ].map(([label, v]) => (
            <div key={label} className="pl-cov">
              <span className="pl-cov-label">{label}</span>
              <div className="pl-cov-track" title={`${fmtNum(v)} of ${fmtNum(cov.total)}`}><div className="pl-cov-fill" style={{ width: `${pct(v, cov.total)}%` }} /></div>
              <span className="pl-mono pl-cov-val">{pct(v, cov.total)}%</span>
            </div>
          ))}
        </div>
      </div>

      <div className="pl-grid-2">
        {/* ── Live feed ───────────────────────────────────────────── */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Live feed</span>
            <div className="pl-chips">
              {Object.keys(FEED_FILTERS).map(f => (
                <button key={f} className={`btn sm ${feedFilter === f ? 'primary' : ''}`} onClick={() => setFeedFilter(f)}>{f}</button>
              ))}
            </div>
          </div>
          <div className="pl-feed">
            {feed.length === 0 && <div className="pl-muted pl-pad">Waiting for events…</div>}
            {feed.map(e => (
              <div key={e.id} className={`pl-feed-row pl-tone-${EVENT_TONE(e)}`}>
                <span className="pl-dot" />
                <span className="pl-mono pl-muted pl-feed-time">{new Date(e.timestamp).toLocaleTimeString()}</span>
                <span className="pl-feed-type pl-mono">{e.type}</span>
                <span className="pl-feed-text">{describeEvent(e)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Running jobs + queues ───────────────────────────────── */}
        <div className="card">
          <div className="card-header"><span className="card-title">Running jobs</span><Globe2 size={14} className="pl-muted" /></div>
          {(snap?.runningJobs || []).length === 0 && <div className="pl-muted pl-pad">No running jobs.</div>}
          {(snap?.runningJobs || []).map(j => {
            const p = j.progress || {};
            const done = (p.scraped || 0) + (p.failed || 0) + (p.skipped || 0);
            const heartbeatAge = j.lastHeartbeatAt ? Date.now() - new Date(j.lastHeartbeatAt).getTime() : null;
            return (
              <div key={j.jobId} className="pl-job">
                <div className="pl-meter-head">
                  <span><span className={`badge-type ${j.type}`}>{j.type}</span> {j.input?.cityName || j.input?.regionName || j.input?.spaceName || j.input?.chainName || j.jobId}</span>
                  <span className={`pl-mono ${heartbeatAge > 600_000 ? 'pl-text-bad' : 'pl-muted'}`}>beat {fmtMs(heartbeatAge)} ago</span>
                </div>
                <div className="pl-cov-track"><div className="pl-cov-fill" style={{ width: `${pct(done, p.toScrape || p.total)}%` }} /></div>
                <div className="pl-muted pl-small pl-mono">
                  {done}/{p.toScrape ?? p.total ?? '?'} · +{p.newSpaces || 0} new · {p.updatedSpaces || 0} upd · {p.skipped || 0} skip · {p.failed || 0} fail · batches {p.batchesDone ?? 0}/{p.batches ?? 0} · running {fmtMs(Date.now() - new Date(j.startedAt).getTime())}
                </div>
              </div>
            );
          })}

          <div className="card-header" style={{ marginTop: 16 }}><span className="card-title">Queues</span></div>
          <table className="pl-table">
            <thead><tr><th>Queue</th><th>Waiting</th><th>Active</th><th>Delayed</th><th>Failed</th></tr></thead>
            <tbody>
              {['crawl', 'chain', 'enrichment'].map(name => (
                <tr key={name}>
                  <td>{name}{q.paused?.[name] && <span className="pl-chip pl-tone-warn" style={{ marginLeft: 6 }}>paused</span>}</td>
                  <td className="pl-mono">{fmtNum(q[name]?.waiting)}</td>
                  <td className="pl-mono">{fmtNum(q[name]?.active)}</td>
                  <td className="pl-mono">{fmtNum(q[name]?.delayed)}</td>
                  <td className="pl-mono">{fmtNum(q[name]?.failed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <style>{`
        .pl-page { padding-top: 20px; padding-bottom: 60px; }
        .pl-header { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
        .pl-h1 { font-size: 24px; font-weight: 800; color: var(--text-primary); display: flex; align-items: center; gap: 8px; margin: 0 0 4px; }
        .pl-header-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        .pl-muted { color: var(--text-muted); }
        .pl-small { font-size: 12px; }
        .pl-pad { padding: 12px 0; }
        .pl-mono { font-family: var(--mono); font-size: 11px; }
        .pl-text-bad { color: var(--danger); }
        .pl-alerts { display: grid; gap: 8px; margin-bottom: 16px; }
        .pl-banner { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 10px; font-size: 13px; color: var(--text-primary); border: 1px solid var(--border); background: var(--bg-surface); flex-wrap: wrap; }
        .pl-banner.pl-tone-bad { border-color: rgba(239, 68, 68, 0.4); }
        .pl-banner.pl-tone-warn { border-color: rgba(245, 158, 11, 0.4); }
        .pl-banner svg { flex-shrink: 0; }
        .pl-banner.pl-tone-bad svg { color: var(--danger); }
        .pl-banner.pl-tone-warn svg { color: var(--warning); }
        .pl-banner code { font-family: var(--mono); font-size: 12px; background: var(--bg-surface); padding: 1px 6px; border-radius: 6px; }

        .pl-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 20px; }
        .pl-kpi { padding: 14px 16px; }
        .pl-kpi-label { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-secondary); }
        .pl-kpi-value { font-size: 26px; font-weight: 800; color: var(--text-primary); margin: 6px 0 2px; font-variant-numeric: tabular-nums; }
        .pl-kpi-sub { font-size: 11px; color: var(--text-muted); }
        .pl-kpi-bad { border-color: rgba(239, 68, 68, 0.45); }

        .pl-section-title { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-secondary); margin: 4px 0 10px; }
        .pl-workers { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr)); gap: 12px; margin-bottom: 20px; }
        .pl-worker { padding: 14px 16px; min-width: 0; }
        .pl-worker-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
        .pl-worker-title { display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--text-primary); }
        .pl-worker-meta { color: var(--text-muted); margin: 4px 0 12px; overflow-wrap: anywhere; }

        .pl-meter { margin-bottom: 10px; }
        .pl-meter-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
        .pl-meter-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); }

        .pl-chips { display: flex; gap: 6px; flex-wrap: wrap; }
        .pl-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-secondary); background: var(--bg-surface); white-space: nowrap; }
        .pl-chip b { color: var(--text-primary); font-variant-numeric: tabular-nums; }
        .pl-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); flex-shrink: 0; display: inline-block; }
        .pl-tone-good .pl-dot   { background: var(--success); }
        .pl-tone-bad .pl-dot    { background: var(--danger); }
        .pl-tone-warn .pl-dot   { background: var(--warning); }
        .pl-tone-active .pl-dot { background: var(--accent); box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.2); }

        .pl-table-wrap { overflow-x: auto; }
        .pl-table { width: 100%; border-collapse: collapse; font-size: 12px; }
        .pl-table th { text-align: left; font-weight: 600; color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px; padding: 6px 8px; border-bottom: 1px solid var(--table-border); }
        .pl-table td { padding: 6px 8px; border-bottom: 1px solid var(--table-border); color: var(--text-secondary); vertical-align: middle; }
        .pl-target { color: var(--text-primary) !important; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        .pl-grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 12px; margin-bottom: 20px; }
        .pl-source { margin-bottom: 18px; }
        .pl-stack { display: flex; gap: 2px; height: 12px; border-radius: 4px; overflow: hidden; background: var(--progress-bg); }
        .pl-seg { min-width: 3px; border-radius: 4px; }
        .pl-bg-good { background: var(--success); }
        .pl-bg-warn { background: var(--warning); }
        .pl-bg-bad { background: var(--danger); }
        .pl-bg-neutral { background: var(--progress-bg); }
        .pl-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; font-size: 12px; color: var(--text-secondary); }
        .pl-legend b { color: var(--text-primary); font-variant-numeric: tabular-nums; }
        .pl-swatch { display: inline-block; width: 9px; height: 9px; border-radius: 3px; margin-right: 5px; vertical-align: middle; }

        .pl-cov { display: grid; grid-template-columns: 110px 1fr 44px; align-items: center; gap: 10px; margin-bottom: 10px; }
        .pl-cov-label { font-size: 12px; color: var(--text-secondary); }
        .pl-cov-track { height: 8px; border-radius: 4px; background: var(--progress-bg); overflow: hidden; margin: 6px 0; }
        .pl-cov-fill { height: 100%; border-radius: 4px; background: var(--accent); transition: width 0.4s ease; }
        .pl-cov-val { text-align: right; color: var(--text-primary); }

        .pl-feed { max-height: 460px; overflow-y: auto; display: flex; flex-direction: column; }
        .pl-feed-row { display: grid; grid-template-columns: 10px 70px 170px 1fr; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--table-border); font-size: 12px; }
        .pl-feed-type { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pl-feed-text { color: var(--text-primary); overflow-wrap: anywhere; }
        .pl-job { margin-bottom: 14px; }

        @media (max-width: 640px) {
          .pl-feed-row { grid-template-columns: 10px 1fr; }
          .pl-feed-time, .pl-feed-type { display: none; }
          .pl-kpi-value { font-size: 22px; }
          .pl-cov { grid-template-columns: 90px 1fr 40px; }
        }
      `}</style>
    </div>
  );
}
