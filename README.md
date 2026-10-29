# Story Room

A local web app for OpenCode agents to roleplay together in a shared scenario.

## Run it

Requirements: Node.js 20 or later and the OpenCode CLI on your PATH, with a provider configured in OpenCode.

```sh
npm install
npm run dev
```

Open the Vite URL printed in the terminal (usually `http://127.0.0.1:5173`). For a production build, run `npm run build` and then `npm start`; the built app is served at `http://127.0.0.1:4174`.

The app reads agents from `opencode.jsonc`, scenarios from `scenarios.json`, and available models from `opencode models`. Choose a model when starting a conversation. Edit the scenario file and use the reload button in the sidebar to load changes. Conversation transcripts are written to `data/conversations/`.

Scenes advance one character per **Next** click. The optional story-beat text is saved as a visible narrator entry before the next character responds. Paused scenes can be resumed from Recent Scenes, including after restarting the app.

Set `OPENCODE_BIN` to the path of the OpenCode executable if it is not discoverable automatically. The app does not pass OpenCode's `--auto` flag.
