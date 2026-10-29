import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import "./models.css";
import "./visual-novel.css";
import "./retry.css";

type Agent = { id: string; name: string; description: string; system: string };
type Scenario = { id: string; title: string; setup: string };
type Turn = { type?: "agent" | "narrator"; agentId: string; agentName: string; text: string; createdAt: string };
type Conversation = {
  id: string; scenarioId: string; scenarioTitle: string; setup: string; agentIds: string[]; model?: string;
  nextAgentIndex?: number; rounds?: number; completedRounds?: number;
  status: "running" | "generating" | "waiting" | "completed" | "stopped" | "error" | "interrupted";
  turns: Turn[]; createdAt: string; updatedAt: string; error?: string;
};
type Bootstrap = { agents: Agent[]; scenarios: Scenario[]; models: string[] };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value as T;
}

function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap>({ agents: [], scenarios: [], models: [] });
  const [history, setHistory] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [scenarioId, setScenarioId] = useState("");
  const [model, setModel] = useState("");
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [storyBeat, setStoryBeat] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    Promise.all([api<Bootstrap>("/api/bootstrap"), api<Conversation[]>("/api/conversations")])
      .then(([config, conversations]) => {
        setBootstrap(config); setHistory(conversations);
        setScenarioId(config.scenarios[0]?.id ?? "");
        setModel((current) => current && config.models.includes(current) ? current : config.models.find((item) => item === "opencode/beam-free") ?? config.models[0] ?? "");
        setAgentIds(config.agents.map((agent) => agent.id));
        const resumable = conversations.find((conversation) => ["waiting", "generating", "error", "interrupted"].includes(conversation.status) && conversation.nextAgentIndex !== undefined);
        if (resumable) {
          setSelected(resumable);
          if (resumable.model && config.models.includes(resumable.model)) setModel(resumable.model);
        }
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [refreshToken]);

  useEffect(() => {
    if (!selected || !["generating", "running"].includes(selected.status)) { setBusy(false); return; }
    setBusy(true);
    const stream = new EventSource(`/api/conversations/${selected.id}/events`);
    stream.addEventListener("snapshot", (event) => {
      const snapshot = JSON.parse((event as MessageEvent).data) as Conversation;
      setSelected(snapshot); setBusy(["generating", "running"].includes(snapshot.status));
    });
    stream.addEventListener("turn", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { turn: Turn; nextAgentIndex: number };
      setSelected((current) => current ? { ...current, turns: current.turns.some((turn) => turn.createdAt === payload.turn.createdAt) ? current.turns : [...current.turns, payload.turn], nextAgentIndex: payload.nextAgentIndex } : current);
    });
    stream.addEventListener("turn-start", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { agentName: string; turnNumber: number };
      setSelected((current) => current ? { ...current, activeTurn: `${payload.agentName} · Turn ${payload.turnNumber}` } as Conversation : current);
    });
    stream.addEventListener("waiting", (event) => {
      const conversation = JSON.parse((event as MessageEvent).data) as Conversation;
      setSelected(conversation); setBusy(false); stream.close();
    });
    stream.addEventListener("done", (event) => {
      const result = JSON.parse((event as MessageEvent).data) as Conversation;
      setSelected(result); setBusy(false); stream.close();
    });
    stream.addEventListener("failure", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { message: string };
      setError(payload.message); setBusy(false); setSelected((current) => current ? { ...current, status: "error", error: payload.message } : current); stream.close();
    });
    stream.onerror = () => { stream.close(); setBusy(false); setRefreshToken((value) => value + 1); };
    return () => stream.close();
  }, [selected?.id, selected?.status]);

  async function startConversation() {
    setError(""); setBusy(true);
    try {
      const conversation = await api<Conversation>("/api/conversations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenarioId, model, agentIds: bootstrap.agents.map((agent) => agent.id).filter((id) => agentIds.includes(id)) }),
      });
      setSelected(conversation);
      setHistory((items) => [conversation, ...items]);
    } catch (reason) { setBusy(false); setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function stopConversation() {
    if (!selected) return;
    try {
      const result = await api<{ stopped: boolean; status: string }>(`/api/conversations/${selected.id}/stop`, { method: "POST" });
      if (result.status === "stopped") setSelected((current) => current ? { ...current, status: "stopped" } : current);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function advanceConversation() {
    if (!selected || !isWaiting || advancing) return;
    setAdvancing(true);
    setError("");
    try {
      const conversation = await api<Conversation>(`/api/conversations/${selected.id}/next`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storyBeat }),
      });
      setStoryBeat(""); setSelected(conversation);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setAdvancing(false); }
  }

  async function retryTurn() {
    if (!selected) return;
    setError("");
    try {
      const conversation = await api<Conversation>(`/api/conversations/${selected.id}/retry`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }),
      });
      setSelected(conversation);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function openConversation(id: string) {
    try {
      const conversation = await api<Conversation>(`/api/conversations/${id}`);
      setSelected(conversation); setStoryBeat(""); setError("");
      if (conversation.model && bootstrap.models.includes(conversation.model)) setModel(conversation.model);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  const isRunning = busy && ["generating", "running"].includes(selected?.status ?? "");
  const isWaiting = selected?.status === "waiting";
  const activeTurn = (selected as (Conversation & { activeTurn?: string }) | null)?.activeTurn;
  const nextAgentId = selected?.agentIds[(selected.nextAgentIndex ?? 0) % Math.max(selected.agentIds.length, 1)];
  const nextAgentName = bootstrap.agents.find((agent) => agent.id === nextAgentId)?.name ?? nextAgentId ?? "Next character";
  const spokenTurns = selected?.turns.filter((turn) => turn.type !== "narrator").length ?? 0;

  return <main className="app-shell">
    <header className="topbar">
      <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setSelected(null); }}>
        <span className="brand-mark">◈</span><span>STORY ROOM</span>
      </a>
      <span className="local-pill"><i /> LOCAL WORKSPACE</span>
    </header>

    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-heading"><span>YOUR CHARACTERS</span><button className="icon-button" title="Reload config and scenarios" onClick={() => setRefreshToken((value) => value + 1)}>↻</button></div>
        <div className="character-list">
          {bootstrap.agents.map((agent, index) => <label className={`character ${agentIds.includes(agent.id) ? "selected" : ""}`} key={agent.id}>
            <input type="checkbox" checked={agentIds.includes(agent.id)} disabled={isRunning} onChange={() => setAgentIds((ids) => ids.includes(agent.id) ? ids.filter((id) => id !== agent.id) : [...ids, agent.id])} />
            <span className={`avatar avatar-${index % 4}`}>{agent.name[0]}</span>
            <span className="character-copy"><b>{agent.name}</b><small>{agent.description || "OpenCode agent"}</small></span>
            <span className="checkmark">✓</span>
          </label>)}
          {!loading && bootstrap.agents.length === 0 && <p className="empty-note">No agents found in opencode.jsonc.</p>}
        </div>

        <div className="sidebar-heading history-heading"><span>RECENT SCENES</span><span className="count">{history.length}</span></div>
        <div className="history-list">
          {history.map((item) => <button className={`history-item ${selected?.id === item.id ? "active" : ""}`} key={item.id} onClick={() => openConversation(item.id)}>
            <span className="history-icon">◷</span><span className="history-copy"><b>{item.scenarioTitle}</b><small>{new Date(item.createdAt).toLocaleString()}</small></span>
            <span className={`status-dot ${item.status}`} />
          </button>)}
          {!loading && history.length === 0 && <p className="empty-note history-empty">Your conversations will show up here.</p>}
        </div>

        <div className="sidebar-foot"><span className="foot-glyph">⌘</span><span>Powered by OpenCode</span></div>
      </aside>

      <section className="main-panel">
        {loading ? <div className="welcome loading"><span className="spinner" />Loading your agents…</div> : !selected ? <div className="welcome">
          <div className="welcome-eyebrow"><span className="sparkle">✳</span> A LITTLE CROSSWORLD CONVERSATION</div>
          <h1>Put them in a room.<br /><em>See what happens.</em></h1>
          <p className="intro">Gather your OpenCode agents into one shared story. They’ll take turns, react to each other, and figure things out together.</p>
          <section className="setup-card">
            <div className="field-label">CHOOSE A SCENARIO <button className="refresh-text" onClick={() => setRefreshToken((value) => value + 1)}>↻ Reload file</button></div>
            <select value={scenarioId} onChange={(event) => setScenarioId(event.target.value)} disabled={isRunning}>
              {bootstrap.scenarios.map((scenario) => <option value={scenario.id} key={scenario.id}>{scenario.title}</option>)}
            </select>
            <div className="model-row"><label className="field-label" htmlFor="model-select">MODEL</label><select id="model-select" value={model} onChange={(event) => setModel(event.target.value)} disabled={isRunning}>
              {bootstrap.models.map((item) => <option value={item} key={item}>{item}</option>)}
            </select></div>
            <p className="scenario-preview">{bootstrap.scenarios.find((scenario) => scenario.id === scenarioId)?.setup}</p>
            <div className="setup-bottom">
              <span className="turn-mode-note">Take the story one character at a time</span>
              <button className="start-button" disabled={!scenarioId || !model || !agentIds.length || isRunning} onClick={startConversation}>Start the scene <span>↗</span></button>
            </div>
            <div className="secure-note"><span>⌑</span> Runs locally with your configured OpenCode agents</div>
          </section>
          {error && <div className="error-banner">{error}</div>}
        </div> : <div className="conversation-view">
          <div className="scene-header">
            <div><div className="welcome-eyebrow"><span className="sparkle">✳</span> {isWaiting ? "YOUR MOVE" : isRunning ? "SCENE IN PROGRESS" : selected.status.toUpperCase()}</div><h1>{selected.scenarioTitle}</h1></div>
            <div className="scene-actions">{isRunning ? <button className="stop-button" onClick={stopConversation}><span>■</span> End after this turn</button> : <button className="new-scene" onClick={() => { setSelected(null); setError(""); setStoryBeat(""); }}>+ New scene</button>}</div>
          </div>
          <div className="scene-setup"><span className="setup-icon">✦</span><p>{selected.setup}</p></div>
          <div className="conversation-meta"><span>{selected.agentIds.map((id) => bootstrap.agents.find((agent) => agent.id === id)?.name ?? id).join("  ·  ")} <span className="meta-divider">/</span> {selected.model ?? "Saved scene"}</span><span>TURN {spokenTurns}</span></div>
          <div className="turn-list">
            {selected.turns.map((turn, index) => <article className={`turn-card ${turn.type === "narrator" ? "narrator-card" : ""}`} key={`${turn.createdAt}-${index}`}>
              <div className={`turn-avatar ${turn.type === "narrator" ? "narrator-avatar" : `avatar-${index % 4}`}`}>{turn.type === "narrator" ? "✦" : turn.agentName[0]}</div>
              <div className="turn-body"><div className="turn-byline"><b>{turn.agentName}</b><time>{new Date(turn.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></div><p>{turn.text}</p></div>
            </article>)}
            {isRunning && <div className="thinking-row"><span className="thinking-dots"><i /><i /><i /></span><span>{activeTurn ? `${activeTurn} is speaking…` : "The characters are gathering…"}</span></div>}
            {!isRunning && selected.turns.length === 0 && <div className="empty-conversation">No turns were recorded for this scene.</div>}
          </div>
          {isWaiting && <section className="director-panel">
            <label htmlFor="story-beat">ADD TO THE STORY <span>OPTIONAL</span></label>
            <textarea id="story-beat" value={storyBeat} maxLength={2000} onChange={(event) => setStoryBeat(event.target.value)} placeholder="A new foe appears from the shadows. He is huge..." />
            <div className="director-actions"><button className="stop-button" onClick={stopConversation}>End scene</button><button className="next-button" disabled={advancing} onClick={advanceConversation}>{advancing ? "Starting..." : `Next: ${nextAgentName}`} <span>→</span></button></div>
          </section>}
          {(error || selected.status === "error" || selected.status === "interrupted") && <div className="error-banner conversation-error">{error || selected.error || "This turn needs to be retried."}</div>}
          {(selected.status === "error" || selected.status === "interrupted") && selected.nextAgentIndex !== undefined && <div className="retry-panel">
            <label htmlFor="retry-model">RETRY MODEL</label>
            <select id="retry-model" value={model} onChange={(event) => setModel(event.target.value)}>
              {bootstrap.models.map((item) => <option value={item} key={item}>{item}</option>)}
            </select>
            <button className="retry-button" disabled={!model} onClick={retryTurn}>Retry {nextAgentName}</button>
          </div>}
          {!isRunning && !isWaiting && selected.status !== "error" && selected.status !== "interrupted" && <div className={`ending-note ${selected.status}`}><span>{selected.status === "completed" ? "✧" : selected.status === "stopped" ? "Ⅱ" : "!"}</span>{selected.status === "completed" ? "Scene complete" : selected.status === "stopped" ? "Scene ended" : `Scene ${selected.status}`}</div>}
        </div>}
        <footer className="main-footer"><span>Let the story unfold, one turn at a time.</span><span>SCENARIOS.JSON <span className="footer-sep">·</span> LOCAL TRANSCRIPTS</span></footer>
      </section>
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
