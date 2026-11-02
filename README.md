# Story Room

A local roleplay web app powered by Groq. Create character personalities and scenarios, guide each scene one turn at a time, and choose who speaks next.

## Run it

Requirements: Node.js 20 or later and a Groq API key. Put `GROQ_API_KEY=your-key` in a `.env` file in the project root. The key remains on the server and is never sent to the browser; `.env` is ignored by Git.

```sh
npm install
npm run dev
```

Open the Vite URL printed in the terminal (usually `http://127.0.0.1:5173`). For a production build, run `npm run build` and then `npm start`; the built app is served at `http://127.0.0.1:4174`.

The app starts with the characters in `characters.json` and the scenario in `scenarios.json`. Create and edit characters and scenarios in the app; these changes are saved to `data/library.json`. Groq models are loaded from the Groq API. Conversation transcripts are written to `data/conversations/`.

Scenes advance one character per **Next** click. Choose the next speaker, add an optional narrator beat, or add a character to the cast while the scene is paused. Paused scenes can be resumed from Recent Scenes, including after restarting the app. Groq free-tier rate limits may interrupt long scenes; failed turns can be retried.
