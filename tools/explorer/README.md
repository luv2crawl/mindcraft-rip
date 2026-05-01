# Mindcraft Bot Explorer

A small local dashboard for understanding, visualizing, and planning improvements to the Mindcraft bot.

## Run

From the repo root:

```
npm run explorer
```

Then open http://localhost:7331

Set `EXPLORER_PORT=8080` to use a different port.

## What it does

- **Flow tab.** Mermaid diagram of the prompt → action loop, plus 13 stage cards. Click any stage (or any numbered node in the diagram) to open a side drawer with the source files involved (`src/agent/agent.js#L308-330`, etc.), the notes / pain points the explorer surfaced when grounding the doc against code, and quick links to the improvement themes that touch that stage. Each file in the drawer has a `view` button that loads the actual code slice from the repo.
- **Research tab.** A curated set of recommendations distilled from agent-research literature (Voyager, Reflexion, GITM, JARVIS-1, DEPS, MemGPT, ReAct, Generative Agents, CRITIC) and Anthropic's effective-agents writeups — every recommendation is tied to specific Mindcraft components. You can attach a note to any recommendation, and "Add to Plans" promotes it into the kanban.
- **Plans tab.** A simple drag-and-drop kanban (Backlog / Planned / In progress / Done). Persists to `tools/explorer/data/plans.json`.
- **Doc drift tab.** Things in `docs/bot-flow.md` that have drifted from the live source.

## Files

```
tools/explorer/
  server.js              # Express app
  data/
    flow.json            # 13 stages + diagram + doc-drift list
    research.json        # quick wins, themed recommendations, bigger bets
    plans.json           # your kanban (created on first save)
    notes.json           # your notes per stage / recommendation (created on first save)
  public/
    index.html
    app.js
    styles.css
```

`flow.json` and `research.json` are checked in — edit them by hand to keep the explorer current as the bot evolves. `plans.json` and `notes.json` are user-state and can be gitignored if you want.

## API

- `GET  /api/flow`              → flow.json
- `GET  /api/research`          → research.json
- `GET  /api/plans`             → plans.json
- `PUT  /api/plans`             → save plans.json (`{ cards: [...] }`)
- `GET  /api/notes`             → notes.json
- `PUT  /api/notes/:key`        → save a note (`{ text: "..." }`)
- `GET  /api/source?path=&start=&end=` → read a slice of any file inside the repo
- `GET  /api/repo-info`         → name / deps / scripts summary
