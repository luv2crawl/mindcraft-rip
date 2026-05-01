# Bot Prompt-To-Action Flow

This document describes the main runtime flow from an incoming chat prompt to an LLM response, command execution, follow-up prompting, and memory updates.

## 1. Startup And Runtime Components

`Agent.start()` wires together the main systems before the Minecraft bot begins responding:

- `Prompter` owns prompt construction, model calls, examples, command docs, skill docs, and memory-summary prompts.
- `History` owns recent conversation turns, the long-term conversation summary, and persisted memory files.
- `ActionManager` tracks running actions and coordinates action execution.
- `ObjectiveStack` tracks higher-level objectives.
- `MemoryBank` stores structured world facts such as known positions or named locations.
- `SelfPrompter` can generate system/self prompts when autonomous follow-up is needed.
- `TranscriptLogger` records observability events for chat, prompt construction, model calls, commands, memory saves, and failures.

During startup the agent loads profile configuration, examples, skill libraries, optional saved history, and memory state. It then initializes the Mineflayer bot, registers event handlers, starts mode updates, and begins listening for chat, whisper, death, idle, and disconnect events.

## 2. Incoming Chat

Chat and whisper messages enter through the response handler created in `Agent._setupEventHandlers()`.

The handler:

- ignores messages from the bot itself;
- filters configured server chatter and ignored users;
- records inbound transcript events;
- optionally translates incoming chat to English;
- calls `Agent.handleMessage(source, message)`.

`source` is usually the player name. System/autonomous prompts use `system` or the bot's own name.

## 3. Direct Command Shortcut

Before asking the LLM, `handleMessage()` checks whether a human player sent a valid command directly, such as:

```text
!viewChest()
```

If the incoming player message already contains a command:

1. The command is parsed and validated.
2. Invalid commands are rejected with a validation response.
3. Valid commands are executed immediately with `executeCommand()`.
4. The command output is routed back to chat.
5. No conversation prompt is sent to the LLM for that message.

This path is for explicit user commands. Natural language requests go through the prompt loop.

## 4. History Update

For normal language input, `handleMessage()` adds context to `History` before prompting.

History turns use OpenAI-style roles:

- player messages become `user` turns and are prefixed with the player name;
- `system` messages become `system` turns;
- bot messages become `assistant` turns.

Mode behavior logs can also be inserted as a system message before the user request. This gives the model immediate context about what the bot has been doing.

After each addition, history is saved to `bots/{bot_name}/memory.json`.

## 5. Prompt Preparation

`handleMessage()` calls:

```js
prompter.promptConvo(history.getHistory())
```

`Prompter.promptConvo()` starts from the active profile's conversation prompt template and fills placeholders through `replaceStrings()`.

Important placeholders include:

- `$NAME`: bot name.
- `$STATS`: current status from commands like `!stats`, `!entities`, and `!nearbyBlocks`.
- `$INVENTORY`: current inventory.
- `$ACTION`: current action state.
- `$COMMAND_DOCS`: available command documentation, excluding blocked actions.
- `$EXAMPLES`: retrieved examples relevant to the latest user intent.
- `$MEMORY`: the long-term conversation summary from `History.memory`.
- `$CONVO`: recent conversation turns.
- `$SELF_PROMPT`: current self-prompting state.
- `$LAST_GOALS`: recent objective-stack goals.
- `$BLUEPRINTS`: known blueprint/context data.

The examples system is intended to show the model the command style expected for the current request. Recent changes make it prefer the latest user intent rather than the whole conversation, so a new request like "can you mine iron ore" should retrieve mining examples instead of stale social examples from earlier chat.

## 6. LLM Request

`promptConvo()` sends the prepared prompt and recent message history to the configured chat model.

Before and after the request it applies several guardrails:

- respects model cooldown settings;
- retries up to three times;
- records transcript `model.request`, `model.response`, or `model.failure` events;
- drops responses if a newer user message arrived while the model was thinking;
- removes stray `</think>` reasoning prefixes when present;
- filters hallucinated `(FROM OTHER BOT)` responses.

If all attempts fail or are stale, it returns an empty response.

## 7. LLM Response Handling

`handleMessage()` processes the model response in one of three ways.

### Empty Response

If the response is empty, the loop stops.

### Chat Response

If the response contains no command:

1. The assistant response is added to history.
2. The text is routed to chat through `routeResponse()`.
3. The loop ends for that user message.

### Command Response

If the response contains a command:

1. The response is truncated after the first command. Later commands in the same response are ignored.
2. The assistant response is added to history.
3. The command name and arguments are parsed and validated.
4. Invalid or hallucinated commands add a system error to history and the loop asks the model again.
5. Valid commands are optionally announced to chat, depending on settings.
6. `executeCommand()` runs the command.
7. The command output is added back to history as a system message.
8. The loop prompts the model again, now with the action result in context.

That command-result re-prompt is the core reasoning loop.

## 8. Command Execution

Commands are defined in `src/agent/commands`. The dispatcher in `commands/index.js`:

- detects command syntax with `containsCommand()`;
- validates command names and argument types with `parseCommandMessage()`;
- records `command.parsed`, `command.start`, `command.end`, and `command.failure` transcript events;
- calls the command's `perform(agent, ...args)` function;
- returns the command output string to the prompt loop.

Commands fall broadly into two categories:

- Query commands return information immediately, such as inventory, nearby blocks, or chest contents.
- Action commands perform work in the world, often through the action manager and Mineflayer controls/pathfinder.

The command output matters because it becomes the next system turn. For example, a failed mining search, a long chest listing, or "no iron found" directly affects the next LLM decision.

## 9. Reasoning And Re-Prompt Loop

`handleMessage()` can run multiple model-command cycles for one incoming request. The limit is controlled by `settings.max_commands`, unless a caller provides a smaller `max_responses`.

A typical multi-step flow looks like this:

1. User says: "mine some iron ore".
2. The model responds with a planning or mining command.
3. The command executes and returns an action result.
4. The result is added as a system message.
5. The model is prompted again with the updated state.
6. The model either issues another command or sends a final chat response.

This is how the bot reasons after tool feedback. The model does not directly inspect the world; it asks commands to inspect or act, then reasons from their textual outputs.

The loop can also be interrupted or redirected by:

- newer user messages arriving while a model call is in progress;
- invalid command feedback;
- self-prompting state;
- mode interruptions;
- death or idle events;
- the bot being told to stop, shut up, or pause.

## 10. Modes And Autonomous Follow-Up

The bot has an update loop that runs roughly every 300ms. It updates modes and the self-prompter, and checks whether active tasks are done.

Modes can affect prompt context in two ways:

- they can produce behavior logs that are inserted as system context before a user message;
- they can trigger automatic system prompts when an action is interrupted or needs follow-up.

Death handling is another autonomous path. When the bot dies, it stores the last death position in memory and sends a system prompt asking the model to respond to the death event.

## 11. Memory System

There are three related but separate memory/logging systems.

### Recent Conversation History

`History.turns` stores the recent promptable conversation. This is what `$CONVO` uses.

When the number of turns reaches `settings.max_messages`, `History` removes an older chunk and queues it for summarization. It keeps the remaining conversation aligned so the active prompt does not start with dangling assistant-only context.

### Long-Term Conversation Summary

Older conversation chunks are summarized through:

```js
prompter.promptMemSaving(turns)
```

The resulting summary is stored in `History.memory` and injected into future prompts as `$MEMORY`.

The memory summary path is failure-safe:

- summaries run behind a queue;
- summary calls have a timeout;
- failures keep the previous memory instead of blocking normal operation;
- saved memory is capped to a short text summary.

`History.save()` persists memory, recent turns, self-prompting state, task start time, and last sender to:

```text
bots/{bot_name}/memory.json
```

`History.load()` restores that state on startup when memory loading is enabled.

Full removed history chunks are archived under:

```text
bots/{bot_name}/histories/
```

### Structured World Memory

`MemoryBank` is separate from the natural-language conversation summary. It stores named world facts and locations, such as home chest position, mining entry points, or last death position.

This memory is useful for command logic and navigation. It is not the same thing as `$MEMORY`, though commands and prompt context may expose some structured facts back to the model.

### Transcript Logs

`TranscriptLogger` is an observability system, not prompt memory. It records what happened so a developer can inspect a session later:

- inbound and outbound chat;
- prompt/model request metadata;
- model responses and failures;
- command parse/start/end/failure events;
- memory save/load/summary events;
- action and lifecycle events.

Transcript entries help debug cases where the bot chose the wrong example, misread a command result, got stuck in navigation, or repeated a bad action.

## 12. Why Tool Output Quality Matters

The LLM's next decision depends heavily on command output text because command results are inserted back into history as system turns.

This means tool output should be:

- concise enough to fit in context;
- specific enough for the model to act on;
- clear about success, failure, and partial progress;
- careful with long listings such as full chest contents;
- explicit when the bot is genuinely stuck versus temporarily navigating, swimming, or opening a door.

Bad or overly long tool output can cause bad follow-up reasoning. For example, a truncated full chest listing may hide the relevant item count, and a vague stuck message may cause the model to abandon a task that is still recoverable.

## 13. Main Files

- `src/agent/agent.js`: chat handlers, prompt/action loop, response routing, lifecycle events.
- `src/models/prompter.js`: prompt construction, placeholder replacement, model calls, memory-summary prompts.
- `src/agent/history.js`: recent turns, memory summary, persistence, full-history archival.
- `src/agent/commands/index.js`: command detection, parsing, validation, execution dispatch.
- `src/utils/examples.js`: relevant example retrieval for `$EXAMPLES`.
- `src/utils/text.js`: text normalization and fallback relevance scoring.
