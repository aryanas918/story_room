import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import "./models.css";
import "./visual-novel.css";
import "./retry.css";
import "./library.css";

type Character = { id: string; name: string; description: string; system: string };
type Scenario = { id: string; title: string; setup: string };
type Turn = { type?: "agent" | "narrator"; agentId: string; agentName: string; text: string; createdAt: string };
type Conversation = { id: string; scenarioId: string; scenarioTitle: string; setup: string; agentIds: string[]; characters?: Character[]; model?: string; provider?: "groq"; nextAgentId?: string; nextAgentIndex?: number; status: "running" | "generating" | "waiting" | "completed" | "stopped" | "error" | "interrupted"; turns: Turn[]; createdAt: string; updatedAt: string; error?: string; activeTurn?: string };
type Bootstrap = { agents: Character[]; characters: Character[]; scenarios: Scenario[]; models: string[]; groqConfigured: boolean; error?: string };
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init); const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`); return value as T;
}
const blankCharacter = (): Character => ({ id: "", name: "", description: "", system: "" });
const blankScenario = (): Scenario => ({ id: "", title: "", setup: "" });
function makeId(value: string) { return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap>({ agents: [], characters: [], scenarios: [], models: [], groqConfigured: false });
  const [history, setHistory] = useState<Conversation[]>([]); const [selected, setSelected] = useState<Conversation | null>(null);
  const [scenarioId, setScenarioId] = useState(""); const [model, setModel] = useState(""); const [agentIds, setAgentIds] = useState<string[]>([]);
  const [nextAgentId, setNextAgentId] = useState(""); const [storyBeat, setStoryBeat] = useState(""); const [newCharacterId, setNewCharacterId] = useState("");
  const [busy, setBusy] = useState(false); const [advancing, setAdvancing] = useState(false); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  const [manager, setManager] = useState<"characters" | "scenarios" | null>(null); const [editingCharacter, setEditingCharacter] = useState<Character>(blankCharacter()); const [editingScenario, setEditingScenario] = useState<Scenario>(blankScenario()); const [saving, setSaving] = useState(false);

  async function reload() {
    const [config, conversations] = await Promise.all([api<Bootstrap>("/api/bootstrap"), api<Conversation[]>("/api/conversations")]);
    setBootstrap(config); setHistory(conversations); setScenarioId((current) => config.scenarios.some((s) => s.id === current) ? current : config.scenarios[0]?.id ?? "");
    setModel((current) => current && config.models.includes(current) ? current : config.models[0] ?? "");
    setAgentIds((current) => current.length ? current.filter((id) => config.characters.some((c) => c.id === id)) : config.characters.map((c) => c.id));
    return { config, conversations };
  }
  useEffect(() => { reload().then(({ config, conversations }) => {
    const resumable = conversations.find((item) => item.provider === "groq" && ["waiting", "generating", "error", "interrupted"].includes(item.status));
    if (resumable) { setSelected(resumable); if (resumable.model && config.models.includes(resumable.model)) setModel(resumable.model); }
    if (config.error) setError(config.error);
  }).catch((reason: Error) => setError(reason.message)).finally(() => setLoading(false)); }, []);

  useEffect(() => {
    if (!selected || !["generating", "running"].includes(selected.status)) { setBusy(false); return; }
    setBusy(true); const stream = new EventSource(`/api/conversations/${selected.id}/events`);
    stream.addEventListener("snapshot", (event) => { const snapshot = JSON.parse((event as MessageEvent).data) as Conversation; setSelected(snapshot); setBusy(["generating", "running"].includes(snapshot.status)); });
    stream.addEventListener("turn", (event) => { const payload = JSON.parse((event as MessageEvent).data) as { turn: Turn }; setSelected((current) => current ? { ...current, turns: current.turns.some((turn) => turn.createdAt === payload.turn.createdAt) ? current.turns : [...current.turns, payload.turn] } : current); });
    stream.addEventListener("turn-start", (event) => { const value = JSON.parse((event as MessageEvent).data) as { agentName: string; turnNumber: number }; setSelected((current) => current ? { ...current, activeTurn: `${value.agentName} · Turn ${value.turnNumber}` } : current); });
    stream.addEventListener("waiting", (event) => { const conversation = JSON.parse((event as MessageEvent).data) as Conversation; setSelected(conversation); setBusy(false); setNextAgentId(conversation.agentIds[0] ?? ""); stream.close(); void api<Conversation[]>("/api/conversations").then(setHistory); });
    stream.addEventListener("done", (event) => { const result = JSON.parse((event as MessageEvent).data) as Conversation; setSelected(result); setBusy(false); stream.close(); void api<Conversation[]>("/api/conversations").then(setHistory); });
    stream.addEventListener("failure", (event) => { const payload = JSON.parse((event as MessageEvent).data) as { message: string }; setError(payload.message); setBusy(false); setSelected((current) => current ? { ...current, status: "error", error: payload.message } : current); stream.close(); });
    stream.onerror = () => { stream.close(); setBusy(false); void api<Conversation>(`/api/conversations/${selected.id}`).then(setSelected).catch(() => undefined); };
    return () => stream.close();
  }, [selected?.id, selected?.status]);

  async function startConversation() {
    setError(""); setBusy(true);
    try {
      const conversation = await api<Conversation>("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenarioId, model, agentIds }) });
      setSelected(conversation); setHistory((items) => [conversation, ...items]);
    } catch (reason) { setBusy(false); setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function advanceConversation() {
    if (!selected || selected.status !== "waiting" || advancing || !nextAgentId) return;
    setAdvancing(true); setError("");
    try { const conversation = await api<Conversation>(`/api/conversations/${selected.id}/next`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ storyBeat, nextAgentId }) }); setStoryBeat(""); setSelected(conversation); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setAdvancing(false); }
  }
  async function retryTurn() {
    if (!selected) return; setError("");
    try { setSelected(await api<Conversation>(`/api/conversations/${selected.id}/retry`, { method: "POST" })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function stopConversation() {
    if (!selected) return;
    try { const result = await api<{ status: string }>(`/api/conversations/${selected.id}/stop`, { method: "POST" }); if (result.status === "stopped") setSelected((value) => value ? { ...value, status: "stopped" } : value); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function openConversation(id: string) {
    try { const conversation = await api<Conversation>(`/api/conversations/${id}`); setSelected(conversation); setStoryBeat(""); setError(""); setNextAgentId(conversation.agentIds[0] ?? ""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function addCharacterToScene() {
    if (!selected || !newCharacterId) return;
    try { const conversation = await api<Conversation>(`/api/conversations/${selected.id}/characters`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ characterId: newCharacterId }) }); setSelected(conversation); setNewCharacterId(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function saveCharacter(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    const value = { ...editingCharacter, id: editingCharacter.id || makeId(editingCharacter.name) };
    try { await api(`/api/characters${bootstrap.characters.some((item) => item.id === value.id) ? `/${value.id}` : ""}`, { method: bootstrap.characters.some((item) => item.id === value.id) ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }); await reload(); setEditingCharacter(blankCharacter()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  }
  async function deleteCharacter(character: Character) {
    if (!window.confirm(`Delete ${character.name} from your character library?`)) return;
    try { await api(`/api/characters/${character.id}`, { method: "DELETE" }); await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function saveScenario(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError(""); const value = { ...editingScenario, id: editingScenario.id || makeId(editingScenario.title) };
    try { await api(`/api/scenarios${bootstrap.scenarios.some((item) => item.id === value.id) ? `/${value.id}` : ""}`, { method: bootstrap.scenarios.some((item) => item.id === value.id) ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }); await reload(); setEditingScenario(blankScenario()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  }
  async function deleteScenario(scenario: Scenario) {
    if (!window.confirm(`Delete scenario “${scenario.title}”?`)) return;
    try { await api(`/api/scenarios/${scenario.id}`, { method: "DELETE" }); await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  const cast = useMemo(() => selected ? (selected.characters ?? selected.agentIds.map((id) => bootstrap.characters.find((item) => item.id === id)).filter((item): item is Character => Boolean(item))) : [], [selected, bootstrap.characters]);
  const isLegacy = Boolean(selected && selected.provider !== "groq");
  const isRunning = !isLegacy && busy && ["generating", "running"].includes(selected?.status ?? ""); const isWaiting = !isLegacy && selected?.status === "waiting";
  const availableForScene = bootstrap.characters.filter((character) => !selected?.agentIds.includes(character.id));
  const spokenTurns = selected?.turns.filter((turn) => turn.type !== "narrator").length ?? 0;
  return <main className="app-shell">
    <header className="topbar"><a className="brand" href="#" onClick={(event) => { event.preventDefault(); setSelected(null); }}><span className="brand-mark">◈</span><span>STORY ROOM</span></a><span className="local-pill"><i /> LOCAL WORKSPACE · GROQ</span></header>
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-heading"><span>YOUR CHARACTERS</span><button className="icon-button" title="Manage characters" onClick={() => { setManager(manager === "characters" ? null : "characters"); setEditingCharacter(blankCharacter()); }}>＋</button></div>
        <div className="character-list">{bootstrap.characters.map((character, index) => <label className={`character ${agentIds.includes(character.id) ? "selected" : ""}`} key={character.id}>
          <input type="checkbox" checked={agentIds.includes(character.id)} disabled={isRunning || Boolean(selected)} onChange={() => setAgentIds((ids) => ids.includes(character.id) ? ids.filter((id) => id !== character.id) : [...ids, character.id])} />
          <span className={`avatar avatar-${index % 4}`}>{character.name[0]}</span><span className="character-copy"><b>{character.name}</b><small>{character.description || "Custom character"}</small></span><span className="checkmark">✓</span>
        </label>)}{!loading && bootstrap.characters.length === 0 && <p className="empty-note">Add a character to begin.</p>}</div>
        <div className="sidebar-heading history-heading"><span>RECENT SCENES</span><span className="count">{history.length}</span></div>
        <div className="history-list">{history.map((item) => <button className={`history-item ${selected?.id === item.id ? "active" : ""}`} key={item.id} onClick={() => openConversation(item.id)}><span className="history-icon">◷</span><span className="history-copy"><b>{item.scenarioTitle}</b><small>{new Date(item.createdAt).toLocaleString()}</small></span><span className={`status-dot ${item.status}`} /></button>)}{!loading && history.length === 0 && <p className="empty-note history-empty">Your conversations will show up here.</p>}</div>
        <div className="sidebar-foot"><span className="foot-glyph">✦</span><span>Groq key stays on this machine</span></div>
      </aside>
      <section className="main-panel">
        {manager && <section className="library-manager"><div className="manager-heading"><b>{manager === "characters" ? "Character library" : "Scenario library"}</b><button className="icon-button" onClick={() => setManager(null)}>×</button></div>
          {manager === "characters" ? <><div className="library-items">{bootstrap.characters.map((character) => <div className="library-item" key={character.id}><span><b>{character.name}</b><small>{character.description || character.id}</small></span><button onClick={() => setEditingCharacter(character)}>Edit</button><button className="danger-link" onClick={() => void deleteCharacter(character)}>Delete</button></div>)}</div>
            <form className="library-form" onSubmit={saveCharacter}><b>{editingCharacter.id ? "Edit character" : "Create character"}</b><input required placeholder="Character name" value={editingCharacter.name} onChange={(e) => setEditingCharacter({ ...editingCharacter, name: e.target.value })} /><input placeholder="Short description" value={editingCharacter.description} onChange={(e) => setEditingCharacter({ ...editingCharacter, description: e.target.value })} /><textarea required placeholder="Personality and roleplay instructions" value={editingCharacter.system} onChange={(e) => setEditingCharacter({ ...editingCharacter, system: e.target.value })} /><div className="manager-actions"><button type="button" onClick={() => setEditingCharacter(blankCharacter())}>Clear</button><button className="start-button" disabled={saving}>{saving ? "Saving…" : "Save character"}</button></div></form></> : <><div className="library-items">{bootstrap.scenarios.map((scenario) => <div className="library-item" key={scenario.id}><span><b>{scenario.title}</b><small>{scenario.id}</small></span><button onClick={() => setEditingScenario(scenario)}>Edit</button><button className="danger-link" onClick={() => void deleteScenario(scenario)}>Delete</button></div>)}</div>
            <form className="library-form" onSubmit={saveScenario}><b>{editingScenario.id ? "Edit scenario" : "Create scenario"}</b><input required placeholder="Scenario title" value={editingScenario.title} onChange={(e) => setEditingScenario({ ...editingScenario, title: e.target.value })} /><textarea required placeholder="Scene setup and premise" value={editingScenario.setup} onChange={(e) => setEditingScenario({ ...editingScenario, setup: e.target.value })} /><div className="manager-actions"><button type="button" onClick={() => setEditingScenario(blankScenario())}>Clear</button><button className="start-button" disabled={saving}>{saving ? "Saving…" : "Save scenario"}</button></div></form></>}
        </section>}
        {!selected ? <div className="welcome"><div className="welcome-eyebrow"><span className="sparkle">✳</span> A SHARED STORY, ONE TURN AT A TIME</div><h1>Gather your <em>characters.</em></h1><p className="intro">Build a cast, set the scene, and guide the story as it unfolds. Choose who speaks next after every turn.</p>
          <section className="setup-card"><label className="field-label" htmlFor="scenario-select">CHOOSE A SCENARIO <button className="refresh-text" onClick={() => { setManager("scenarios"); setEditingScenario(blankScenario()); }}>Manage scenarios</button></label><select id="scenario-select" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}><option value="">Select a scenario</option>{bootstrap.scenarios.map((scenario) => <option value={scenario.id} key={scenario.id}>{scenario.title}</option>)}</select>
            <div className="model-row"><label className="field-label" htmlFor="model-select">GROQ MODEL</label><select id="model-select" value={model} onChange={(e) => setModel(e.target.value)}><option value="">Select a model</option>{bootstrap.models.map((item) => <option value={item} key={item}>{item}</option>)}</select></div>
            <p className="scenario-preview">{bootstrap.scenarios.find((scenario) => scenario.id === scenarioId)?.setup}</p><div className="setup-bottom"><span className="turn-mode-note">{agentIds.length} characters selected</span><button className="start-button" disabled={!scenarioId || !model || !agentIds.length || isRunning} onClick={() => void startConversation()}>Start the scene <span>↗</span></button></div>
            <div className="secure-note"><span>⌑</span> Uses GROQ_API_KEY from the local server environment</div>
          </section>
          {bootstrap.error && <div className="error-banner">{bootstrap.error}</div>}{error && <div className="error-banner">{error}</div>}
        </div> : <div className="conversation-view"><div className="scene-header"><div><div className="welcome-eyebrow"><span className="sparkle">✳</span> {isWaiting ? "YOUR MOVE" : isRunning ? "SCENE IN PROGRESS" : selected.status.toUpperCase()}</div><h1>{selected.scenarioTitle}</h1></div><div className="scene-actions">{isRunning ? <button className="stop-button" onClick={() => void stopConversation()}>■ End after this turn</button> : <button className="new-scene" onClick={() => { setSelected(null); setError(""); setStoryBeat(""); }}>+ New scene</button>}</div></div>
          <div className="scene-setup"><span className="setup-icon">✦</span><p>{selected.setup}</p></div><div className="conversation-meta"><span>{cast.map((character) => character.name).join(" · ")} <span className="meta-divider">/</span> {selected.model ?? "Legacy conversation"}</span><span>TURN {spokenTurns}</span></div>
          <div className="turn-list">{selected.turns.map((turn, index) => <article className={`turn-card ${turn.type === "narrator" ? "narrator-card" : ""}`} key={`${turn.createdAt}-${index}`}><div className={`turn-avatar ${turn.type === "narrator" ? "narrator-avatar" : `avatar-${index % 4}`}`}>{turn.type === "narrator" ? "✦" : turn.agentName[0]}</div><div className="turn-body"><div className="turn-byline"><b>{turn.agentName}</b><time>{new Date(turn.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></div><p>{turn.text}</p></div></article>)}{isRunning && <div className="thinking-row"><span className="thinking-dots"><i /><i /><i /></span><span>{selected.activeTurn ?? "The characters are gathering…"}</span></div>}{!isRunning && !selected.turns.length && <div className="empty-conversation">No turns were recorded for this scene.</div>}</div>
          {isWaiting && <section className="director-panel"><label htmlFor="story-beat">ADD TO THE STORY <span>OPTIONAL</span></label><textarea id="story-beat" value={storyBeat} maxLength={2000} onChange={(e) => setStoryBeat(e.target.value)} placeholder="A new foe appears from the shadows…" />
            <div className="speaker-choice"><label htmlFor="next-speaker">NEXT SPEAKER</label><select id="next-speaker" value={nextAgentId} onChange={(e) => setNextAgentId(e.target.value)}>{cast.map((character) => <option value={character.id} key={character.id}>{character.name}</option>)}</select><button onClick={() => void stopConversation()}>End scene</button><button className="next-button" disabled={advancing || !nextAgentId} onClick={() => void advanceConversation()}>{advancing ? "Starting…" : "Next speaker"} <span>→</span></button></div>
            {availableForScene.length > 0 && <div className="add-cast"><label htmlFor="add-character">ADD A CHARACTER</label><select id="add-character" value={newCharacterId} onChange={(e) => setNewCharacterId(e.target.value)}><option value="">Choose character</option>{availableForScene.map((c) => <option value={c.id} key={c.id}>{c.name}</option>)}</select><button onClick={() => void addCharacterToScene()} disabled={!newCharacterId}>Add to scene</button></div>}
          </section>}
          {(error || selected.status === "error" || selected.status === "interrupted") && <div className="error-banner conversation-error">{error || selected.error || "This turn needs to be retried."}</div>}
          {isLegacy && <div className="ending-note">Legacy OpenCode conversation · history only</div>}
          {!isLegacy && (selected.status === "error" || selected.status === "interrupted") && <button className="retry-button" onClick={() => void retryTurn()}>Retry {cast.find((c) => c.id === (selected.nextAgentId ?? selected.agentIds[selected.nextAgentIndex ?? 0]))?.name ?? "next character"}</button>}
          {!isLegacy && !isRunning && !isWaiting && selected.status !== "error" && selected.status !== "interrupted" && <div className={`ending-note ${selected.status}`}>{selected.status === "stopped" ? "Scene ended" : selected.status}</div>}
        </div>}
        <footer className="main-footer"><span>Let the story unfold, one turn at a time.</span><span>GROQ API <span className="footer-sep">·</span> LOCAL TRANSCRIPTS</span></footer>
      </section>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
