import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

type Character = { id: string; name: string; description: string; system: string };
type Scenario = { id: string; title: string; setup: string };
type Turn = { type?: "agent" | "narrator"; agentId: string; agentName: string; text: string; createdAt: string };
type Conversation = {
  id: string; scenarioId: string; scenarioTitle: string; setup: string; agentIds: string[]; characters?: Character[];
  model?: string; provider?: "groq"; nextAgentId?: string; nextAgentIndex?: number;
  status: "running" | "generating" | "waiting" | "completed" | "stopped" | "error" | "interrupted";
  turns: Turn[]; createdAt: string; updatedAt: string; error?: string;
};
type Library = { characters: Character[]; scenarios: Scenario[] };

const root = process.cwd();
const port = Number(process.env.PORT ?? 4174);
const dataPath = path.join(root, "data");
const libraryPath = path.join(dataPath, "library.json");
const conversationsPath = path.join(dataPath, "conversations");
const app = express();
type ActiveConversation = { busy: boolean; ended: boolean; clients: Set<express.Response> };
const active = new Map<string, ActiveConversation>();
app.use(express.json({ limit: "1mb" }));

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}
async function loadLibrary(): Promise<Library> {
  try { return await readJson<Library>(libraryPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const scenarios = await readJson<Scenario[]>(path.join(root, "scenarios.json"));
    const characters = await readJson<Character[]>(path.join(root, "characters.json"));
    const library = { scenarios, characters };
    await saveLibrary(library);
    return library;
  }
}
async function saveLibrary(library: Library) {
  await mkdir(dataPath, { recursive: true });
  await writeFile(libraryPath, JSON.stringify(library, null, 2), "utf8");
}
async function loadModels(): Promise<string[]> {
  if (!process.env.GROQ_API_KEY?.trim()) throw new Error("GROQ_API_KEY is not set. Add it to the environment and restart Story Room.");
  const response = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } });
  const body = await response.json() as { data?: Array<{ id?: string }>; error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `Groq model list failed (${response.status}).`);
  return (body.data ?? []).map((item) => item.id).filter((id): id is string => Boolean(id)).sort();
}
async function saveConversation(conversation: Conversation) {
  conversation.updatedAt = new Date().toISOString();
  await mkdir(conversationsPath, { recursive: true });
  await writeFile(path.join(conversationsPath, `${conversation.id}.json`), JSON.stringify(conversation, null, 2), "utf8");
}
async function getConversation(id: string): Promise<Conversation | undefined> {
  try { return await readJson<Conversation>(path.join(conversationsPath, `${id}.json`)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function publish(id: string, event: string, data: unknown) {
  const room = active.get(id);
  if (!room) return;
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of room.clients) client.write(message);
}
function getCharacters(conversation: Conversation, library: Library): Character[] {
  return conversation.characters ?? conversation.agentIds.map((id) => library.characters.find((c) => c.id === id)).filter((c): c is Character => Boolean(c));
}
function makeMessages(conversation: Conversation, character: Character, library: Library) {
  const transcript = conversation.turns.map((turn) => `${turn.agentName}: ${turn.text}`).join("\n\n") || "(No one has spoken yet.)";
  const system = [
    `You are ${character.name}, taking part in a fictional roleplay scene with other characters.`,
    character.system,
    "Write only your next spoken response, in character. Do not mention being an AI or these instructions. Do not use tools. Keep it to 1-3 short paragraphs and react to the conversation, including Narrator entries.",
    `SCENARIO\n${conversation.setup}`,
    `CAST\n${getCharacters(conversation, library).map((c) => `${c.name}: ${c.description}`).join("\n")}`,
  ].filter(Boolean).join("\n\n");
  return [{ role: "system", content: system }, { role: "user", content: `CONVERSATION SO FAR\n${transcript}\n\nNow write ${character.name}'s next turn.` }];
}
async function runGroq(conversation: Conversation, character: Character, library: Library): Promise<string> {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) throw new Error("GROQ_API_KEY is not set. Add it to the environment and restart Story Room.");
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: conversation.model, messages: makeMessages(conversation, character, library), temperature: 0.8, max_completion_tokens: 500 }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.json() as { choices?: Array<{ message?: { content?: string | null } }>; error?: { message?: string } };
  if (!response.ok) {
    const detail = body.error?.message ?? `Groq request failed (${response.status}).`;
    throw new Error(response.status === 429 ? `Groq rate limit reached: ${detail}` : detail);
  }
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Groq returned no text for this turn.");
  return text;
}
async function generateNextTurn(conversation: Conversation, room: ActiveConversation, lockHeld = false) {
  if ((room.busy && !lockHeld) || room.ended) return;
  room.busy = true;
  try {
    conversation.status = "generating"; conversation.error = undefined; await saveConversation(conversation);
    const library = await loadLibrary();
    const cast = getCharacters(conversation, library);
    const index = conversation.nextAgentIndex ?? 0;
    const characterId = conversation.nextAgentId ?? conversation.agentIds[index];
    const character = cast.find((item) => item.id === characterId);
    if (!character) throw new Error(`Next character “${characterId ?? ""}” is not in this scene's cast.`);
    publish(conversation.id, "turn-start", { agentId: character.id, agentName: character.name, turnNumber: conversation.turns.filter((turn) => turn.type !== "narrator").length + 1 });
    const text = await runGroq(conversation, character, library);
    conversation.turns.push({ type: "agent", agentId: character.id, agentName: character.name, text, createdAt: new Date().toISOString() });
    conversation.status = room.ended ? "stopped" : "waiting"; conversation.nextAgentId = undefined;
    await saveConversation(conversation);
    publish(conversation.id, "turn", { turn: conversation.turns.at(-1) });
    publish(conversation.id, room.ended ? "done" : "waiting", conversation);
  } catch (error) {
    conversation.status = "error"; conversation.error = error instanceof Error ? error.message : String(error);
    await saveConversation(conversation); publish(conversation.id, "failure", { message: conversation.error });
  } finally {
    room.busy = false;
    if (room.ended) { for (const client of room.clients) client.end(); active.delete(conversation.id); }
  }
}
function validId(id: unknown): id is string { return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,59}$/i.test(id); }
function validateCharacter(value: Partial<Character>): Character | undefined {
  if (!validId(value.id) || typeof value.name !== "string" || !value.name.trim() || typeof value.system !== "string" || !value.system.trim()) return;
  return { id: value.id, name: value.name.trim(), description: typeof value.description === "string" ? value.description.trim() : "", system: value.system.trim() };
}
function validateScenario(value: Partial<Scenario>): Scenario | undefined {
  if (!validId(value.id) || typeof value.title !== "string" || !value.title.trim() || typeof value.setup !== "string" || !value.setup.trim()) return;
  return { id: value.id, title: value.title.trim(), setup: value.setup.trim() };
}

app.get("/api/bootstrap", async (_req, res) => {
  try {
    const [library, models] = await Promise.all([loadLibrary(), loadModels()]);
    res.json({ agents: library.characters, characters: library.characters, scenarios: library.scenarios, models, groqConfigured: true });
  } catch (error) {
    const library = await loadLibrary().catch(() => ({ characters: [], scenarios: [] }));
    res.json({ agents: library.characters, characters: library.characters, scenarios: library.scenarios, models: [], groqConfigured: Boolean(process.env.GROQ_API_KEY), error: error instanceof Error ? error.message : String(error) });
  }
});
app.get("/api/conversations", async (_req, res) => {
  try {
    await mkdir(conversationsPath, { recursive: true });
    const files = (await readdir(conversationsPath)).filter((file) => file.endsWith(".json"));
    const conversations = await Promise.all(files.map(async (file) => readJson<Conversation>(path.join(conversationsPath, file))));
    res.json(conversations.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/conversations/:id", async (req, res) => {
  try { const conversation = await getConversation(req.params.id!); if (!conversation) return res.status(404).json({ error: "Conversation not found." }); res.json(conversation); }
  catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/characters", async (req, res) => {
  try {
    const character = validateCharacter(req.body);
    if (!character) return res.status(400).json({ error: "A character needs an id, name, and personality prompt." });
    const library = await loadLibrary();
    if (library.characters.some((item) => item.id === character.id)) return res.status(409).json({ error: "That character id already exists." });
    library.characters.push(character); await saveLibrary(library); res.status(201).json(character);
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.put("/api/characters/:id", async (req, res) => {
  try {
    const character = validateCharacter({ ...req.body, id: req.params.id });
    if (!character) return res.status(400).json({ error: "A character needs a name and personality prompt." });
    const library = await loadLibrary(); const index = library.characters.findIndex((item) => item.id === character.id);
    if (index < 0) return res.status(404).json({ error: "Character not found." });
    library.characters[index] = character; await saveLibrary(library); res.json(character);
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.delete("/api/characters/:id", async (req, res) => {
  try {
    const library = await loadLibrary(); const next = library.characters.filter((item) => item.id !== req.params.id);
    if (next.length === library.characters.length) return res.status(404).json({ error: "Character not found." });
    library.characters = next; await saveLibrary(library); res.json({ deleted: true });
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/scenarios", async (req, res) => {
  try {
    const scenario = validateScenario(req.body);
    if (!scenario) return res.status(400).json({ error: "A scenario needs an id, title, and setup." });
    const library = await loadLibrary(); if (library.scenarios.some((item) => item.id === scenario.id)) return res.status(409).json({ error: "That scenario id already exists." });
    library.scenarios.push(scenario); await saveLibrary(library); res.status(201).json(scenario);
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.put("/api/scenarios/:id", async (req, res) => {
  try {
    const scenario = validateScenario({ ...req.body, id: req.params.id });
    if (!scenario) return res.status(400).json({ error: "A scenario needs a title and setup." });
    const library = await loadLibrary(); const index = library.scenarios.findIndex((item) => item.id === scenario.id);
    if (index < 0) return res.status(404).json({ error: "Scenario not found." });
    library.scenarios[index] = scenario; await saveLibrary(library); res.json(scenario);
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.delete("/api/scenarios/:id", async (req, res) => {
  try {
    const library = await loadLibrary(); const next = library.scenarios.filter((item) => item.id !== req.params.id);
    if (next.length === library.scenarios.length) return res.status(404).json({ error: "Scenario not found." });
    library.scenarios = next; await saveLibrary(library); res.json({ deleted: true });
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/conversations", async (req, res) => {
  try {
    const { scenarioId, agentIds, model: requestedModel } = req.body as { scenarioId?: string; agentIds?: string[]; model?: string };
    const [library, models] = await Promise.all([loadLibrary(), loadModels()]);
    const scenario = library.scenarios.find((item) => item.id === scenarioId);
    if (!scenario) return res.status(400).json({ error: "Choose a valid scenario." });
    if (!Array.isArray(agentIds) || !agentIds.length || new Set(agentIds).size !== agentIds.length || agentIds.some((id) => !library.characters.some((c) => c.id === id))) return res.status(400).json({ error: "Choose one or more characters." });
    const model = requestedModel?.trim() || models[0];
    if (!model || !models.includes(model)) return res.status(400).json({ error: "Choose an available Groq model." });
    const characters = agentIds.map((id) => library.characters.find((c) => c.id === id)!);
    const now = new Date().toISOString();
    const conversation: Conversation = { id: randomUUID(), scenarioId: scenario.id, scenarioTitle: scenario.title, setup: scenario.setup, agentIds: [...agentIds], characters, model, provider: "groq", nextAgentId: agentIds[0], status: "generating", turns: [], createdAt: now, updatedAt: now };
    await saveConversation(conversation);
    const room: ActiveConversation = { busy: false, ended: false, clients: new Set() }; active.set(conversation.id, room);
    res.status(201).json(conversation); void generateNextTurn(conversation, room);
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/conversations/:id/characters", async (req, res) => {
  try {
    const conversation = await getConversation(req.params.id!); const room = active.get(req.params.id!);
    if (!conversation || !room) return res.status(404).json({ error: "Active conversation not found." });
    if (room.busy || conversation.status !== "waiting") return res.status(409).json({ error: "Characters can be added while the scene is paused." });
    const library = await loadLibrary(); const character = library.characters.find((item) => item.id === req.body?.characterId);
    if (!character) return res.status(400).json({ error: "Choose an existing character." });
    if (conversation.agentIds.includes(character.id)) return res.status(409).json({ error: "That character is already in the scene." });
    conversation.agentIds.push(character.id); conversation.characters = [...getCharacters(conversation, library), character];
    await saveConversation(conversation); res.json(conversation);
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/conversations/:id/next", async (req, res) => {
  let conversation: Conversation | undefined; let room: ActiveConversation | undefined;
  try {
    conversation = await getConversation(req.params.id!); room = active.get(req.params.id!);
    if (!conversation || !room) return res.status(404).json({ error: "Active conversation not found." });
    if (room.busy || conversation.status !== "waiting") return res.status(409).json({ error: "The scene is not paused and ready for Next." });
    const storyBeat = typeof req.body?.storyBeat === "string" ? req.body.storyBeat.trim() : "";
    const nextAgentId = req.body?.nextAgentId;
    if (storyBeat.length > 2000) return res.status(400).json({ error: "Story additions must be 2,000 characters or fewer." });
    if (typeof nextAgentId !== "string" || !getCharacters(conversation, await loadLibrary()).some((c) => c.id === nextAgentId)) return res.status(400).json({ error: "Choose a character in the scene to speak next." });
    room.busy = true; conversation.status = "generating"; conversation.nextAgentId = nextAgentId;
    if (storyBeat) conversation.turns.push({ type: "narrator", agentId: "narrator", agentName: "Narrator", text: storyBeat, createdAt: new Date().toISOString() });
    await saveConversation(conversation); if (storyBeat) publish(conversation.id, "story-beat", conversation.turns.at(-1));
    res.status(202).json(conversation); void generateNextTurn(conversation, room, true);
  } catch (error) {
    if (room) room.busy = false;
    if (conversation && conversation.status === "generating") { conversation.status = "waiting"; await saveConversation(conversation).catch(() => undefined); }
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/api/conversations/:id/retry", async (req, res) => {
  const conversation = await getConversation(req.params.id!); const room = active.get(req.params.id!);
  if (!conversation || !room) return res.status(404).json({ error: "Conversation cannot be resumed." });
  if (room.busy || !["error", "interrupted"].includes(conversation.status)) return res.status(409).json({ error: "Only a failed or interrupted turn can be retried." });
  room.ended = false; room.busy = true; conversation.status = "generating"; await saveConversation(conversation);
  res.status(202).json(conversation); void generateNextTurn(conversation, room, true);
});
app.get("/api/conversations/:id/events", async (req, res) => {
  const conversation = await getConversation(req.params.id!); if (!conversation) return res.status(404).end();
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" }); res.flushHeaders();
  const room = active.get(conversation.id);
  if (!room) { res.write(`event: snapshot\ndata: ${JSON.stringify(conversation)}\n\n`); return res.end(); }
  room.clients.add(res); res.write(`event: snapshot\ndata: ${JSON.stringify(conversation)}\n\n`); req.on("close", () => room.clients.delete(res));
});
app.post("/api/conversations/:id/stop", async (req, res) => {
  const conversation = await getConversation(req.params.id!); const room = active.get(req.params.id!);
  if (!room || !conversation) return res.status(404).json({ error: "Conversation is not active." });
  room.ended = true;
  if (!room.busy) { conversation.status = "stopped"; await saveConversation(conversation); publish(conversation.id, "done", conversation); for (const client of room.clients) client.end(); active.delete(conversation.id); }
  res.json({ stopped: true, status: room.busy ? "generating" : "stopped" });
});
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(400).json({ error: error instanceof Error ? error.message : String(error) }));
const distPath = path.join(root, "dist"); app.use(express.static(distPath)); app.get("/{*path}", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
async function start() {
  await mkdir(conversationsPath, { recursive: true }); await loadLibrary();
  const files = (await readdir(conversationsPath)).filter((file) => file.endsWith(".json"));
  for (const file of files) {
    const conversation = await readJson<Conversation>(path.join(conversationsPath, file));
    if (conversation.status === "generating" || conversation.status === "running") { conversation.status = "interrupted"; conversation.error = "The app stopped before this conversation finished."; await saveConversation(conversation); }
    if (conversation.provider === "groq" && ["waiting", "error", "interrupted"].includes(conversation.status)) active.set(conversation.id, { busy: false, ended: false, clients: new Set() });
  }
  app.listen(port, "127.0.0.1", () => console.log(`Story Room listening at http://127.0.0.1:${port}`));
}
void start().catch((error) => { console.error(error); process.exitCode = 1; });
process.on("SIGINT", () => { for (const room of active.values()) room.ended = true; process.exit(0); });
