"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Decision, Mode } from "../replay/decision.ts";
import type { IncidentEvent } from "../replay/scenario.ts";

type ScenarioSummary = {
  id: string;
  kind?: "training" | "imported";
  title: string;
  briefing: string;
  checkpoints: { id: string; label: string; cutoffAt: string }[];
  actions: { id: string; label: string }[];
};
type Catalog = {
  mode: Mode;
  scenarios: ScenarioSummary[];
  importsEnabled?: boolean;
  importedEvaluationEnabled?: boolean;
};
type Timeline = { cutoffAt: string; events: IncidentEvent[] };
type Debrief = { summary: string; lessons: string[] };
type Loaded<T> = { value: T; error?: never } | { error: string; value?: never };
type ReplayLocation = { scenarioId: string; checkpointId: string; eventId?: string };

const ABSTAIN = "insufficient_evidence";
const EVENT_PAGE_SIZE = 100;

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message = body?.error?.message;
    throw new Error(typeof message === "string" ? message : "The replay request failed. Try again.");
  }
  return response.json();
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The replay request failed. Try again.";
}

function clock(value: string) {
  return value.slice(11, 19).replace(/:00$/, "");
}

function ModeLabel({ mode }: { mode: Mode }) {
  return <span className={`mode-pill mode-${mode}`}><span aria-hidden="true" />{mode === "live" ? "Live SubQ" : "Demo fixture"}</span>;
}

function focusEvidence(id: string): boolean {
  const element = document.getElementById(`event-${id}`);
  if (!element) return false;
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: "nearest" });
  return true;
}

function readReplayLink(): ReplayLocation | null {
  const params = new URLSearchParams(window.location.search);
  const scenarioId = params.get("scenario");
  const checkpointId = params.get("checkpoint");
  if (!scenarioId || !checkpointId) return null;
  return { scenarioId, checkpointId, eventId: params.get("event") ?? undefined };
}

function replayLink({ scenarioId, checkpointId, eventId }: ReplayLocation): string {
  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set("scenario", scenarioId);
  url.searchParams.set("checkpoint", checkpointId);
  if (eventId) url.searchParams.set("event", eventId);
  return url.href;
}

function EventRecord({ event, fresh, supporting }: { event: IncidentEvent; fresh: boolean; supporting: boolean }) {
  const late = event.occurredAt < event.availableAt;
  const kind = event.kind.toLowerCase();
  return (
    <li className={`event${fresh ? " event-fresh" : ""}`}>
      <div className="event-clock"><time dateTime={event.availableAt} title={event.availableAt}>{clock(event.availableAt)}</time></div>
      <article tabIndex={-1} id={`event-${event.id}`} className={`event-card${supporting ? " event-supporting" : ""}`}>
        <div className="event-heading">
          <span className="event-source">{event.source}</span>
          <span className="event-kind" data-kind={kind}>{event.kind}</span>
          {fresh && <span className="event-fresh-label">New at this checkpoint</span>}
        </div>
        <p>{event.text}</p>
        <div className="event-meta">
          {late && <span className="late-arrival">Late arrival · occurred at <time dateTime={event.occurredAt} title={event.occurredAt}>{clock(event.occurredAt)} UTC</time></span>}
          {supporting && <span className="support-label">Supporting evidence</span>}
        </div>
      </article>
    </li>
  );
}

function ScenarioReplay({
  scenario, mode, importedEvaluationEnabled, initialLink,
}: {
  scenario: ScenarioSummary;
  mode: Mode;
  importedEvaluationEnabled: boolean;
  initialLink: ReplayLocation | null;
}) {
  const [step, setStep] = useState(() => Math.max(0, scenario.checkpoints.findIndex(({ id }) => id === initialLink?.checkpointId)));
  const [reload, setReload] = useState(0);
  const [timeline, setTimeline] = useState<(Loaded<Timeline> & { checkpointId: string }) | null>(null);
  const [source, setSource] = useState("");
  const [search, setSearch] = useState("");
  const [newOnly, setNewOnly] = useState(false);
  const [limit, setLimit] = useState(EVENT_PAGE_SIZE);
  const [prediction, setPrediction] = useState("");
  const [approved, setApproved] = useState(false);
  const [result, setResult] = useState<Loaded<Decision> | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [debrief, setDebrief] = useState<Loaded<Debrief> | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [copyStatus, setCopyStatus] = useState<{ checkpointId: string; kind: "link" | "handoff"; message: string } | null>(null);
  const [focusEvent, setFocusEvent] = useState<string | null>(initialLink?.eventId ?? null);
  const evaluation = useRef<AbortController | null>(null);
  const reveal = useRef<AbortController | null>(null);
  const checkpoint = scenario.checkpoints[step];
  const priorCutoff = scenario.checkpoints[step - 1]?.cutoffAt;
  const base = `/api/scenarios/${encodeURIComponent(scenario.id)}`;
  const lastStep = step === scenario.checkpoints.length - 1;
  const imported = scenario.kind === "imported";
  const canEvaluate = !imported || (mode === "live" && importedEvaluationEnabled);
  const activeTimeline = timeline?.checkpointId === checkpoint.id ? timeline : null;
  const events = activeTimeline?.value?.events ?? [];
  const sources = Array.from(new Set(events.map(({ source }) => source))).sort();
  const query = search.trim().toLowerCase();
  const newEvents = events.filter(({ availableAt }) => !priorCutoff || availableAt > priorCutoff);
  const matching = (newOnly ? newEvents : events).filter((event) => {
    if (source && event.source !== source) return false;
    return !query || `${event.text} ${event.source} ${event.kind} ${event.id}`.toLowerCase().includes(query);
  });

  const focusIndex = focusEvent ? matching.findIndex(({ id }) => id === focusEvent) : -1;
  const effectiveLimit = Math.max(limit, focusIndex < 0 ? 0 : matching.length - focusIndex);
  const shown = imported ? matching.slice(-effectiveLimit) : matching;
  const focusReady = focusIndex >= 0;

  useEffect(() => {
    const controller = new AbortController();
    const checkpointId = checkpoint.id;
    request<Timeline>(`${base}/checkpoints/${encodeURIComponent(checkpointId)}`, { signal: controller.signal }).then(
      (value) => { if (!controller.signal.aborted) setTimeline({ checkpointId, value }); },
      (error) => { if (!controller.signal.aborted) setTimeline({ checkpointId, error: messageOf(error) }); },
    );
    return () => controller.abort();
  }, [base, checkpoint.id, reload]);

  useEffect(() => () => {
    evaluation.current?.abort();
    reveal.current?.abort();
  }, []);

  useEffect(() => {
    if (focusEvent && focusReady) focusEvidence(focusEvent);
  }, [focusEvent, focusReady]);

  function clearFilters() {
    setSource("");
    setSearch("");
    setNewOnly(false);
    setLimit(EVENT_PAGE_SIZE);
  }

  function navigate(index: number) {
    if (index === step || index < 0 || index >= scenario.checkpoints.length) return;
    evaluation.current?.abort();
    reveal.current?.abort();
    setEvaluating(false);
    setRevealing(false);
    setResult(null);
    setDebrief(null);
    setTimeline(null);
    clearFilters();
    setPrediction("");
    setApproved(false);
    setFocusEvent(null);
    setCopyStatus(null);
    setStep(index);
  }

  function navigateByKey(event: KeyboardEvent<HTMLElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    let nextIndex = step;
    if (event.key === "ArrowLeft") nextIndex = Math.max(0, step - 1);
    else if (event.key === "ArrowRight") nextIndex = Math.min(scenario.checkpoints.length - 1, step + 1);
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = scenario.checkpoints.length - 1;
    else return;
    event.preventDefault();
    navigate(nextIndex);
    event.currentTarget.querySelectorAll<HTMLButtonElement>(".checkpoint-list button")[nextIndex]?.focus();
  }

  async function evaluate() {
    if (evaluating || !canEvaluate || (imported && !approved) || !activeTimeline?.value) return;
    evaluation.current?.abort();
    const controller = new AbortController();
    evaluation.current = controller;
    setEvaluating(true);
    setResult(null);
    try {
      const value = await request<Decision>("/api/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenarioId: scenario.id,
          checkpointId: checkpoint.id,
          ...(imported ? { allowImportedEvidence: true } : {}),
        }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setResult({ value });
    } catch (error) {
      if (!controller.signal.aborted) setResult({ error: messageOf(error) });
    } finally {
      if (!controller.signal.aborted) setEvaluating(false);
    }
  }

  async function revealDebrief() {
    if (!lastStep || revealing || imported) return;
    reveal.current?.abort();
    const controller = new AbortController();
    reveal.current = controller;
    setRevealing(true);
    setDebrief(null);
    try {
      const value = await request<Debrief>(`${base}/debrief?checkpointId=${encodeURIComponent(checkpoint.id)}`, { signal: controller.signal });
      if (!controller.signal.aborted) setDebrief({ value });
    } catch (error) {
      if (!controller.signal.aborted) setDebrief({ error: messageOf(error) });
    } finally {
      if (!controller.signal.aborted) setRevealing(false);
    }
  }

  function showSupportingEvent(id: string) {
    const eventIndex = events.findIndex((event) => event.id === id);
    if (eventIndex < 0) return;
    clearFilters();
    setLimit(Math.max(EVENT_PAGE_SIZE, events.length - eventIndex));
    setFocusEvent(id);
    focusEvidence(id);
  }

  async function copyHandoff(decision: Decision) {
    const evidence = decision.evidence;
    const lines = [
      `Incident Replay · ${scenario.title}`,
      `Checkpoint: ${checkpoint.cutoffAt} · ${decision.mode === "live" ? "Live SubQ" : "Demo fixture"}`,
      `Next step: ${decision.recommendation}`,
      evidence
        ? `Supporting event: ${evidence.source} · ${evidence.availableAt} · ${evidence.id}`
        : "Supporting event: none selected",
      `Replay: ${replayLink({ scenarioId: scenario.id, checkpointId: checkpoint.id, eventId: evidence?.id })}`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopyStatus({ checkpointId: checkpoint.id, kind: "handoff", message: "Handoff copied." });
    } catch {
      setCopyStatus({ checkpointId: checkpoint.id, kind: "handoff", message: "Clipboard unavailable. Select and copy the recommendation." });
    }
  }

  async function copyCheckpointLink() {
    const url = replayLink({ scenarioId: scenario.id, checkpointId: checkpoint.id });
    let message = "Checkpoint link copied.";
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.history.replaceState(window.history.state, "", url);
      message = "Copy the checkpoint link from your address bar.";
    }
    setCopyStatus({ checkpointId: checkpoint.id, kind: "link", message });
  }

  const decision = result?.value;
  const recommended = decision && scenario.actions.find(({ id }) => id === decision.actionId);
  const evidence = decision?.evidence;
  const copiedHere = copyStatus?.checkpointId === checkpoint.id ? copyStatus : null;
  const isFiltered = Boolean(source || query || newOnly);

  return (
    <div className="replay">
      <div className="scenario-heading">
        <div>
          <p className="scenario-kind">{imported ? "Imported incident" : "Training scenario"}</p>
          <h1>{scenario.title}</h1>
          <p className="scenario-briefing">{scenario.briefing}</p>
        </div>
        <div className="scenario-clock">
          <span>Evidence available through</span>
          <time dateTime={checkpoint.cutoffAt} title={checkpoint.cutoffAt}>{clock(checkpoint.cutoffAt)} <small>UTC</small></time>
          <button className="text-button checkpoint-link" type="button" onClick={() => void copyCheckpointLink()}>Copy checkpoint link</button>
          {copiedHere?.kind === "link" && <p role="status">{copiedHere.message}</p>}
        </div>
      </div>

      <nav className="checkpoint-nav" aria-label="Checkpoint navigation" onKeyDown={navigateByKey}>
        <div className="checkpoint-progress">
          <h2>Replay checkpoints</h2>
          <p aria-live="polite"><strong>{step + 1}</strong> / {scenario.checkpoints.length}</p>
        </div>
        <div className="checkpoint-controls">
          <button className="checkpoint-arrow" type="button" aria-label="Previous checkpoint" disabled={step === 0} onClick={() => navigate(step - 1)}>←</button>
          <ol className="checkpoint-list">
            {scenario.checkpoints.map((point, index) => (
              <li key={point.id}>
                <button
                  type="button"
                  className={index === step ? "checkpoint-active" : ""}
                  aria-label={point.label}
                  aria-current={index === step ? "step" : undefined}
                  onClick={() => navigate(index)}
                >
                  <span className="checkpoint-number">{String(index + 1).padStart(2, "0")}</span>
                  <time dateTime={point.cutoffAt} title={point.cutoffAt}>{clock(point.cutoffAt)}</time>
                </button>
              </li>
            ))}
          </ol>
          <button className="checkpoint-arrow" type="button" aria-label="Next checkpoint" disabled={lastStep} onClick={() => navigate(step + 1)}>→</button>
        </div>
      </nav>

      <div className="workspace">
        <section className="panel timeline" aria-labelledby="timeline-heading">
          <div className="panel-heading">
            <div><h2 id="timeline-heading">Evidence timeline</h2><p>Ordered by when each event reached the on-call engineer.</p></div>
            {activeTimeline?.value && <span className="event-total">{events.length} visible</span>}
          </div>
          <div className="timeline-tools">
            <label className="evidence-search">
              <span>Search evidence</span>
              <input type="search" value={search} placeholder="Search event text, source or type" onChange={(event) => { setSearch(event.target.value); setLimit(EVENT_PAGE_SIZE); setFocusEvent(null); }} disabled={!activeTimeline?.value} />
            </label>
            <label className="source-filter">
              <span>Source</span>
              <select value={source} onChange={(event) => { setSource(event.target.value); setLimit(EVENT_PAGE_SIZE); setFocusEvent(null); }} disabled={sources.length === 0}>
                <option value="">All sources</option>
                {sources.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
          </div>
          {activeTimeline?.value && (
            <div className="timeline-summary">
              <button className="filter-toggle" type="button" aria-pressed={newOnly} onClick={() => { setNewOnly(!newOnly); setLimit(EVENT_PAGE_SIZE); setFocusEvent(null); }}>
                New at this checkpoint <span>{newEvents.length}</span>
              </button>
              {isFiltered && <button className="text-button" type="button" onClick={() => { clearFilters(); setFocusEvent(null); }}>Clear filters</button>}
              {(isFiltered || shown.length < matching.length) && <p role="status" className="timeline-count">Showing {shown.length} of {matching.length} {isFiltered ? "matches" : "events"}</p>}
            </div>
          )}
          {!activeTimeline && <p role="status" className="panel-note">Loading checkpoint evidence…</p>}
          {activeTimeline?.error && (
            <div className="panel-note">
              <p role="alert">{activeTimeline.error}</p>
              <button type="button" className="secondary" onClick={() => { setTimeline(null); setReload(reload + 1); }}>Retry loading evidence</button>
            </div>
          )}
          {shown.length < matching.length && <button className="secondary more-events" type="button" onClick={() => setLimit(effectiveLimit + EVENT_PAGE_SIZE)}>Show {Math.min(EVENT_PAGE_SIZE, matching.length - shown.length)} older events</button>}
          {activeTimeline?.value && (
            matching.length > 0
              ? <ol className="events">{shown.map((event) => <EventRecord key={event.id} event={event} fresh={!priorCutoff || event.availableAt > priorCutoff} supporting={event.id === evidence?.id} />)}</ol>
              : <p className="panel-note">{isFiltered ? "No events match these filters." : "No events at this checkpoint."}</p>
          )}
        </section>

        <section className="panel diagnosis" aria-labelledby="diagnosis-heading">
          <div className="panel-heading">
            <div><h2 id="diagnosis-heading">{imported ? "Recommended next step" : "Choose your next step"}</h2><p>{imported ? "Get a read-only diagnostic recommendation for the selected checkpoint." : "Make a prediction, then compare it with the recommendation."}</p></div>
          </div>
          {decision && (
            <div className="result" aria-live="polite" aria-atomic="true">
              <div className="result-heading">
                <span className="result-kicker">{recommended ? "Suggested diagnostic" : "Gather more evidence"}</span>
                <ModeLabel mode={decision.mode} />
              </div>
              <h3>{recommended?.label ?? "Insufficient evidence"}</h3>
              <p>{decision.recommendation}</p>
              {prediction && <p className="comparison">{prediction === decision.actionId ? "Your choice matches the recommendation." : "Your choice differs from the recommendation."}</p>}
              {evidence && (
                <div className="result-evidence">
                  <span>{evidence.source} · {clock(evidence.availableAt)} UTC</span>
                  <button type="button" className="text-button" onClick={() => showSupportingEvent(evidence.id)}>View supporting event <span aria-hidden="true">↗</span></button>
                </div>
              )}
              {decision.mode === "live" && (
                <p className="coverage">
                  {decision.submittedEventCount} of {decision.availableEventCount} visible events sent
                  {decision.contextReduced ? " · Context trimmed" : ""}
                  {decision.inputTokens !== undefined ? ` · ${decision.inputTokens.toLocaleString("en-US")} input tokens` : ""}
                  {decision.estimatedCostUsd !== undefined ? ` · $${decision.estimatedCostUsd.toFixed(6)} estimated` : ""}
                </p>
              )}
              <button type="button" className="secondary copy-handoff" onClick={() => void copyHandoff(decision)}>Copy handoff</button>
              <p role="status" className="copy-status">{copiedHere?.kind === "handoff" ? copiedHere.message : null}</p>
            </div>
          )}
          {!decision && !imported && (
            <fieldset disabled={evaluating}>
              <legend className="sr-only">Your prediction</legend>
              {[...scenario.actions, { id: ABSTAIN, label: "Insufficient evidence" }].map((action) => (
                <label className="action" key={action.id}>
                  <input type="radio" name="prediction" value={action.id} checked={prediction === action.id} onChange={() => setPrediction(action.id)} />
                  <span>{action.label}</span>
                </label>
              ))}
            </fieldset>
          )}
          {!decision && !canEvaluate && <p className="decision-unavailable">Timeline review is available. To evaluate imported incidents, ask the operator to enable live evaluation for imported evidence on this instance.</p>}
          {!decision && canEvaluate && (
            <>
              {imported && (
                <div className="import-consent">
                  <strong>Review evidence before sending</strong>
                  <p>SubQ can receive evidence available through {clock(checkpoint.cutoffAt)} UTC, including events hidden by your filters. Review the timeline for sensitive content before approving.</p>
                  <label>
                    <input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} disabled={evaluating || !activeTimeline?.value} />
                    <span>Allow SubQ to receive this checkpoint’s evidence</span>
                  </label>
                </div>
              )}
              <button className="primary" type="button" disabled={!activeTimeline?.value || evaluating || (imported && !approved)} onClick={evaluate}>
                {evaluating ? "Evaluating…" : mode === "live" ? "Evaluate with SubQ" : "Reveal recommendation"}
                <span aria-hidden="true">↗</span>
              </button>
              {mode === "live" && !imported && <p className="live-note">Uses your configured key to evaluate the synthetic evidence.</p>}
            </>
          )}
          {result?.error && <p className="error-note" role="alert">{result.error}</p>}

          {lastStep && !imported && (
            <div className="debrief">
              <h3>Incident debrief</h3>
              {!debrief?.value && <button type="button" className="secondary" disabled={revealing} onClick={revealDebrief}>{revealing ? "Loading debrief…" : "Reveal debrief"}</button>}
              {debrief?.error && <p role="alert" className="error-note">{debrief.error}</p>}
              {debrief?.value && (
                <div className="debrief-content" aria-live="polite">
                  <p>{debrief.value.summary}</p>
                  <ul>{debrief.value.lessons.map((lesson) => <li key={lesson}>{lesson}</li>)}</ul>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function IncidentLibrary({ catalog, active, select }: { catalog: Catalog; active: ScenarioSummary; select: (id: string) => void }) {
  const training = catalog.scenarios.filter(({ kind }) => kind !== "imported");
  const imported = catalog.scenarios.filter(({ kind }) => kind === "imported");
  return (
    <aside className="library" aria-labelledby="library-heading">
      <div className="library-heading">
        <h2 id="library-heading">Incident library</h2>
        <p>{training.length} training{catalog.importsEnabled || imported.length > 0 ? ` · ${imported.length} imported` : ""}</p>
      </div>
      <label className="scenario-select">
        <span className="sr-only">Scenario</span>
        <select value={active.id} onChange={(event) => select(event.target.value)}>
          {training.length > 0 && <optgroup label="Training scenarios">{training.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}</optgroup>}
          {imported.length > 0 && <optgroup label="Imported incidents">{imported.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}</optgroup>}
        </select>
      </label>
      <details className="import-help">
        <summary>Import an incident</summary>
        <div>
          <p>On the host, import an event file, a Grafana Loki export, or GitHub deployment statuses.</p>
          <code>npm run import:incident -- --help</code>
          <p>{catalog.importsEnabled ? "Restart the server after importing, then reload the library." : "Enable private imports on the host, then restart the server."}</p>
        </div>
      </details>
    </aside>
  );
}

export default function Replay() {
  const [catalog, setCatalog] = useState<Loaded<Catalog> | null>(null);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState("");
  const [linked, setLinked] = useState<ReplayLocation | null>(null);
  const active = catalog?.value?.scenarios.find((scenario) => scenario.id === selected) ?? catalog?.value?.scenarios[0];

  useEffect(() => {
    const controller = new AbortController();
    request<Catalog>("/api/scenarios", { signal: controller.signal }).then(
      (value) => {
        if (controller.signal.aborted) return;
        const link = readReplayLink();
        const target = link && value.scenarios.find(({ id }) => id === link.scenarioId);
        if (target && link) {
          setSelected(target.id);
          if (target.checkpoints.some(({ id }) => id === link.checkpointId)) setLinked(link);
        }
        setCatalog({ value });
      },
      (error) => { if (!controller.signal.aborted) setCatalog({ error: messageOf(error) }); },
    );
    return () => controller.abort();
  }, [reload]);

  return (
    <>
      <a className="skip-link" href="#incident-replay">Skip to incident replay</a>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand"><span className="brand-mark" aria-hidden="true">↻</span><span>Incident Replay</span></div>
          {catalog?.value && <ModeLabel mode={catalog.value.mode} />}
        </div>
      </header>
      <main id="incident-replay" className="shell" tabIndex={-1}>
        {!catalog && <p role="status">Loading scenarios…</p>}
        {catalog?.error && <div><p role="alert">{catalog.error}</p><button className="secondary" type="button" onClick={() => { setCatalog(null); setReload(reload + 1); }}>Retry loading scenarios</button></div>}
        {catalog?.value && !active && <p role="status">No incidents are available.</p>}
        {active && catalog?.value && (
          <div className="application">
            <IncidentLibrary catalog={catalog.value} active={active} select={(id) => { setLinked(null); setSelected(id); }} />
            <ScenarioReplay key={active.id} scenario={active} mode={catalog.value.mode} importedEvaluationEnabled={catalog.value.importedEvaluationEnabled === true} initialLink={linked} />
          </div>
        )}
      </main>
    </>
  );
}
