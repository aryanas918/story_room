import express from "express";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

type Agent = { id: string; name: string; description: string; system: string };
type Scenario = { id: string; title: string; setup: string };
type Turn = { type?: "agent" | "narrator"; agentId: string; agentName: string; text: string; createdAt: string };
type Conversation = {
  id: string; scenarioId: string; scenarioTitle: string; setup: string;
  agentIds: string[]; model: string; nextAgentIndex?: number;
  rounds?: number; completedRounds?: number;
  status: "running" | "generating" | "waiting" | "completed" | "stopped" | "error" | "interrupted";
  turns: Turn[]; createdAt: string; updatedAt: string; error?: string;
};

const root = process.cwd();
const port = Number(process.env.PORT ?? 4174);
const scenariosPath = path.join(root, "scenarios.json");
const conversationsPath = path.join(root, "data", "conversations");
const app = express();
type ActiveConversation = { busy: boolean; ended: boolean; clients: Set<express.Response> };
const active = new Map<string, ActiveConversation>();
app.use(express.json({ limit: "1mb" }));

function jsonc<T>(text: string, source: string): T {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) {
    const error = errors[0]!;
    throw new Error(`${source}: ${printParseErrorCode(error.error)} near offset ${error.offset}`);
  }
  return value as T;
}

async function loadAgents(): Promise<Agent[]> {
  const config = jsonc<{ agents?: Record<string, { description?: string; system?: string }> }>(
    await readFile(path.join(root, "opencode.jsonc"), "utf8"), "opencode.jsonc",
  );
  return Object.entries(config.agents ?? {}).map(([id, agent]) => ({
    id, name: id[0]!.toUpperCase() + id.slice(1),
    description: agent.description ?? "", system: agent.system ?? "",
  }));
}

async function loadScenarios(): Promise<Scenario[]> {
  const value = JSON.parse(await readFile(scenariosPath, "utf8")) as unknown;
  if (!Array.isArray(value) || value.some((s) => !s?.id || !s?.title || !s?.setup)) {
    throw new Error("scenarios.json must contain an array of scenarios with id, title, and setup fields.");
  }
  return value as Scenario[];
}

function loadModels(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const { command, shell } = opencodeCommand();
    const child = spawn(command, ["models"], { cwd: root, shell, windowsHide: true, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Timed out while loading OpenCode models.")); }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(stderr.trim() || `OpenCode model list exited with code ${code}.`));
      const models = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (!models.length) return reject(new Error("OpenCode did not report any available models."));
      resolve(models);
    });
  });
}

async function saveConversation(conversation: Conversation) {
  conversation.updatedAt = new Date().toISOString();
  await mkdir(conversationsPath, { recursive: true });
  await writeFile(path.join(conversationsPath, `${conversation.id}.json`), JSON.stringify(conversation, null, 2), "utf8");
}

async function getConversation(id: string): Promise<Conversation | undefined> {
  try { return JSON.parse(await readFile(path.join(conversationsPath, `${id}.json`), "utf8")) as Conversation; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function publish(id: string, event: string, data: unknown) {
  const room = active.get(id);
  if (!room) return;
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of room.clients) client.write(message);
}

function makePrompt(conversation: Conversation, agent: Agent): string {
  const transcript = conversation.turns.length
    ? conversation.turns.map((turn) => `${turn.agentName}: ${turn.text}`).join("\n\n")
    : "(No one has spoken yet.)";
  return [
    "You are taking part in a fictional roleplay scene with other characters.",
    `Speak as ${agent.name}, following your configured character instructions.`,
    "Write only this character's next spoken response, in character. Do not mention being an AI, the prompt, or these instructions. Do not use tools or attempt coding tasks. Keep the response to 1-3 short paragraphs, and react to the conversation so far, including any Narrator events.",
    "\nSCENARIO\n" + conversation.setup,
    "\nCONVERSATION SO FAR\n" + transcript,
    `\nNow write ${agent.name}'s next turn.`,
  ].join("\n");
}

function opencodeCommand(): { command: string; shell: boolean } {
  const configured = process.env.OPENCODE_BIN;
  if (configured) return { command: configured, shell: false };
  if (process.platform === "win32") {
    // npm installs OpenCode's Windows launcher in a PATH directory, while npm
    // scripts often resolve process.execPath to Nodist's versioned Node folder.
    // Search PATH for the actual executable instead of trying to spawn its .cmd shim.
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      const candidates = [
        path.join(directory, "opencode.exe"),
        path.join(directory, "node_modules", "@opencode", "cli", "bin", "opencode.exe"),
      ];
      const binary = candidates.find((candidate) => existsSync(candidate));
      if (binary) return { command: binary, shell: false };
    }
    throw new Error("Could not find the OpenCode executable on PATH. Set OPENCODE_BIN to the path of opencode.exe and restart Story Room.");
  }
  return { command: "opencode", shell: false };
}

async function runAgent(agentId: string, model: string, prompt: string): Promise<string> {
  await mkdir(conversationsPath, { recursive: true });
  const promptDirectory = await mkdtemp(path.join(conversationsPath, ".prompt-"));
  const promptFile = path.join(promptDirectory, "scene-context.txt");
  await writeFile(promptFile, prompt, "utf8");
  try {
    return await new Promise((resolve, reject) => {
    const { command, shell } = opencodeCommand();
    const child = spawn(command, ["--standalone", "run", "--format", "json", "--agent", agentId, "--model", model, "--file", promptFile,
      "Follow the attached Story Room context. It contains the roleplay instructions, scenario, and conversation so far. Reply only with the next in-character dialogue. Do not use tools."], {
      cwd: root, shell, windowsHide: true, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let response = "";
    let cliError = "";
    let remainder = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error(`OpenCode did not finish the ${agentId} turn within 180 seconds.`));
      }
    }, 180_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      remainder += chunk;
      const lines = remainder.split(/\r?\n/);
      remainder = lines.pop() ?? "";
      for (const line of lines) {
        cliError ||= errorFromEvent(line);
        response += textFromEvent(line);
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (!settled) { settled = true; reject(error); }
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (settled) return;
      if (remainder.trim()) {
        cliError ||= errorFromEvent(remainder);
        response += textFromEvent(remainder);
      }
      if (code !== 0) { settled = true; return reject(new Error(cliError || stderr.trim() || `OpenCode exited with code ${code}.`)); }
      if (!response.trim()) {
        // Preserve helpful diagnostics if a CLI version emits a different event shape.
        response = stdout.split(/\r?\n/).map(textFromEvent).join("");
      }
      if (!response.trim()) { settled = true; return reject(new Error("OpenCode returned no text for this turn.")); }
      settled = true;
      resolve(response.trim());
    });
    });
  } finally {
    await rm(promptDirectory, { recursive: true, force: true });
  }
}

function textFromEvent(line: string): string {
  try {
    const event = JSON.parse(line) as { type?: string; part?: { type?: string; text?: string }; text?: string };
    if (event.type === "text" && event.part?.text) return event.part.text;
    if ((event.type === "message.part.updated" || event.type === "message.part") && event.part?.type === "text") return event.part.text ?? "";
    if (event.type === "text" && event.text) return event.text;
    return "";
  } catch { return ""; }
}

function errorFromEvent(line: string): string {
  try {
    const event = JSON.parse(line) as { type?: string; error?: unknown; message?: unknown };
    if (event.type !== "error" && !event.error) return "";
    if (typeof event.error === "string") return event.error;
    if (event.error && typeof event.error === "object") {
      const error = event.error as { message?: unknown; data?: { message?: unknown }; cause?: { message?: unknown } };
      const message = error.message ?? error.data?.message ?? error.cause?.message;
      if (typeof message === "string") return message;
    }
    return typeof event.message === "string" ? event.message : "";
  } catch { return ""; }
}

async function generateNextTurn(conversation: Conversation, room: ActiveConversation, lockHeld = false) {
  if ((room.busy && !lockHeld) || room.ended) return;
  room.busy = true;
  try {
    conversation.status = "generating";
    conversation.error = undefined;
    await saveConversation(conversation);
    const agents = await loadAgents();
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const index = conversation.nextAgentIndex ?? 0;
    const agentId = conversation.agentIds[index];
    const agent = agentId ? byId.get(agentId) : undefined;
    if (!agentId || !agent) throw new Error(`Next agent is missing from opencode.jsonc (index ${index}).`);
    publish(conversation.id, "turn-start", { agentId, agentName: agent.name, turnNumber: conversation.turns.filter((turn) => turn.type !== "narrator").length + 1 });
    const text = await runAgent(agentId, conversation.model, makePrompt(conversation, agent));
    conversation.turns.push({ type: "agent", agentId, agentName: agent.name, text, createdAt: new Date().toISOString() });
    conversation.nextAgentIndex = (index + 1) % conversation.agentIds.length;
    conversation.status = room.ended ? "stopped" : "waiting";
    await saveConversation(conversation);
    publish(conversation.id, "turn", { turn: conversation.turns.at(-1), nextAgentIndex: conversation.nextAgentIndex });
    publish(conversation.id, room.ended ? "done" : "waiting", conversation);
  } catch (error) {
    conversation.status = "error";
    conversation.error = error instanceof Error ? error.message : String(error);
    await saveConversation(conversation);
    publish(conversation.id, "failure", { message: conversation.error });
  } finally {
    room.busy = false;
    if (room.ended) {
      for (const client of room.clients) client.end();
      active.delete(conversation.id);
    }
  }
}

app.get("/api/bootstrap", async (_req, res) => {
  try {
    const [agents, scenarios, models] = await Promise.all([loadAgents(), loadScenarios(), loadModels()]);
    res.json({ agents, scenarios, models });
  }
  catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.get("/api/conversations", async (_req, res) => {
  try {
    await mkdir(conversationsPath, { recursive: true });
    const files = (await readdir(conversationsPath)).filter((file) => file.endsWith(".json"));
    const conversations = await Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(conversationsPath, file), "utf8")) as Conversation));
    res.json(conversations.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.get("/api/conversations/:id", async (req, res) => {
  try {
    const conversation = await getConversation(req.params.id!);
    if (!conversation) return res.status(404).json({ error: "Conversation not found." });
    res.json(conversation);
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/conversations", async (req, res) => {
  try {
    const { scenarioId, agentIds, model: requestedModel } = req.body as { scenarioId?: string; agentIds?: string[]; model?: string };
    const [agents, scenarios] = await Promise.all([loadAgents(), loadScenarios()]);
    const scenario = scenarios.find((item) => item.id === scenarioId);
    if (!scenario) return res.status(400).json({ error: "Choose a valid scenario." });
    if (!Array.isArray(agentIds) || agentIds.length === 0 || new Set(agentIds).size !== agentIds.length || agentIds.some((id) => !agents.some((agent) => agent.id === id))) {
      return res.status(400).json({ error: "Choose one or more configured agents." });
    }
    const model = requestedModel?.trim() || process.env.OPENCODE_MODEL?.trim();
    if (!model) return res.status(400).json({ error: "Choose a model in the API request or set OPENCODE_MODEL before starting Story Room." });
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: randomUUID(), scenarioId: scenario.id, scenarioTitle: scenario.title, setup: scenario.setup,
      agentIds, model, nextAgentIndex: 0, status: "generating", turns: [], createdAt: now, updatedAt: now,
    };
    await saveConversation(conversation);
    const room: ActiveConversation = { busy: false, ended: false, clients: new Set() };
    active.set(conversation.id, room);
    res.status(201).json(conversation);
    void generateNextTurn(conversation, room);
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/conversations/:id/next", async (req, res) => {
  let conversation: Conversation | undefined;
  let room: ActiveConversation | undefined;
  try {
    conversation = await getConversation(req.params.id!);
    room = active.get(req.params.id!);
    if (!conversation || !room) return res.status(404).json({ error: "Active conversation not found." });
    if (room.busy || conversation.status !== "waiting") return res.status(409).json({ error: "The scene is not paused and ready for Next." });
    const storyBeat = typeof req.body?.storyBeat === "string" ? req.body.storyBeat.trim() : "";
    if (storyBeat.length > 2000) return res.status(400).json({ error: "Story additions must be 2,000 characters or fewer." });
    room.busy = true;
    conversation.status = "generating";
    if (storyBeat) {
      conversation.turns.push({ type: "narrator", agentId: "narrator", agentName: "Narrator", text: storyBeat, createdAt: new Date().toISOString() });
      await saveConversation(conversation);
      publish(conversation.id, "story-beat", conversation.turns.at(-1));
    }
    await saveConversation(conversation);
    res.status(202).json(conversation);
    void generateNextTurn(conversation, room, true);
  } catch (error) {
    if (room) room.busy = false;
    if (conversation && conversation.status === "generating") {
      conversation.status = "waiting";
      await saveConversation(conversation).catch(() => undefined);
    }
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/conversations/:id/retry", async (req, res) => {
  let room: ActiveConversation | undefined;
  try {
    const conversation = await getConversation(req.params.id!);
    room = active.get(req.params.id!);
    if (!conversation || !room) return res.status(404).json({ error: "Conversation cannot be resumed." });
    if (room.busy || !["error", "interrupted"].includes(conversation.status)) return res.status(409).json({ error: "Only a failed or interrupted turn can be retried." });
    const requestedModel = typeof req.body?.model === "string" ? req.body.model.trim() : "";
    if (requestedModel) conversation.model = requestedModel;
    room.ended = false;
    room.busy = true;
    conversation.status = "generating";
    await saveConversation(conversation);
    res.status(202).json(conversation);
    void generateNextTurn(conversation, room, true);
  } catch (error) {
    if (room) room.busy = false;
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/conversations/:id/events", async (req, res) => {
  const conversation = await getConversation(req.params.id!);
  if (!conversation) return res.status(404).end();
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const room = active.get(conversation.id);
  if (!room) {
    res.write(`event: snapshot\ndata: ${JSON.stringify(conversation)}\n\n`);
    return res.end();
  }
  room.clients.add(res);
  res.write(`event: snapshot\ndata: ${JSON.stringify(conversation)}\n\n`);
  req.on("close", () => room.clients.delete(res));
});

app.post("/api/conversations/:id/stop", async (req, res) => {
  const conversation = await getConversation(req.params.id!);
  const room = active.get(req.params.id!);
  if (!room || !conversation) return res.status(404).json({ error: "Conversation is not active." });
  room.ended = true;
  if (!room.busy) {
    conversation.status = "stopped";
    await saveConversation(conversation);
    publish(conversation.id, "done", conversation);
    for (const client of room.clients) client.end();
    active.delete(conversation.id);
  }
  res.json({ stopped: true, status: room.busy ? "generating" : "stopped" });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  res.status(400).json({ error: message });
});

const distPath = path.join(root, "dist");
app.use(express.static(distPath));
app.get("/{*path}", (_req, res) => res.sendFile(path.join(distPath, "index.html")));

async function start() {
  await mkdir(conversationsPath, { recursive: true });
  const files = (await readdir(conversationsPath)).filter((file) => file.endsWith(".json"));
  for (const file of files) {
    const conversation = JSON.parse(await readFile(path.join(conversationsPath, file), "utf8")) as Conversation;
    if (conversation.status === "generating" || conversation.status === "running") {
      conversation.status = "interrupted";
      conversation.error = "The app stopped before this conversation finished.";
      await saveConversation(conversation);
    }
    if (["waiting", "error", "interrupted"].includes(conversation.status) && conversation.nextAgentIndex !== undefined) {
      active.set(conversation.id, { busy: false, ended: false, clients: new Set() });
    }
  }
  app.listen(port, "127.0.0.1", () => console.log(`Story Room listening at http://127.0.0.1:${port}`));
}

void start().catch((error) => { console.error(error); process.exitCode = 1; });

process.on("SIGINT", async () => {
  for (const room of active.values()) room.ended = true;
  process.exit(0);
});
