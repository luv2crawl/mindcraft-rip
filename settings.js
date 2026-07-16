const settings = {
    "minecraft_version": "auto", // or specific version like "1.21.6"
    "host": "127.0.0.1", // or "localhost", "your.ip.address.here"
    "port": 55916, // set to -1 to automatically scan for open ports
    "auth": "offline", // or "microsoft"

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8080,
    "auto_open_ui": true, // opens UI in browser on startup
    
    "base_profile": "assistant", // survival, assistant, creative, or god_mode
    "profiles": [
        // "./profiles/deepseek.json",
        "./profiles/gpt.json",
        // "./profiles/claude.json",
        // "./profiles/gemini.json",
        // "./profiles/llama.json",
        // "./profiles/qwen.json",
        // "./profiles/grok.json",
        // "./profiles/mistral.json",
        // "./profiles/mercury.json",
        // "./profiles/andy-4.json", // Supports up to 75 messages!

        // using more than 1 profile requires you to /msg each bot indivually
        // individual profiles override values from the base profile
    ],

    "load_memory": false, // load memory from previous session
    "init_message": "Respond with hello world and your name", // sends to all on spawn
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly

    "speak": false,
    // allows all bots to speak through text-to-speech. 
    // specify speech model inside each profile with format: {provider}/{model}/{voice}.
    // if set to "system" it will use basic system text-to-speech. 
    // Works on windows and mac, but linux requires you to install the espeak package through your package manager eg: `apt install espeak` `pacman -S espeak`.

    "chat_ingame": true, // bot responses are shown in minecraft chat
    "language": "en", // translate to/from this language. Supports these language names: https://cloud.google.com/translate/docs/languages
    "render_bot_view": false, // show bot's view in browser at localhost:3000, 3001...

    "allow_insecure_coding": true, // allows newAction command and model can write/run code on your computer. enable at own risk
    "allow_vision": true, // allows vision model to interpret screenshots as inputs
    "blocked_actions" : ["!checkBlueprint", "!checkBlueprintLevel", "!getBlueprint", "!getBlueprintLevel"] , // commands to disable and remove from docs. Ex: ["!setMode"]
    "code_timeout_mins": -1, // minutes code is allowed to run. -1 for no timeout
    "relevant_docs_count": 5, // number of relevant code function docs to select for prompting. -1 for all

    "max_messages": 15, // max number of messages to keep in context
    "memory_summary_timeout_ms": 20000, // max time to wait for LLM memory summarization before keeping old memory
    "num_examples": 2, // number of examples to give to the model
    "max_commands": -1, // max number of commands that can be used in consecutive responses. -1 for no limit
    "show_command_syntax": "full", // "full", "shortened", or "none"
    "narrate_behavior": true, // chat simple automatic actions ('Picking up item!')
    "chat_bot_messages": true, // publicly chat messages to other bots

    "spawn_timeout": 30, // num seconds allowed for the bot to spawn before throwing error. Increase when spawning takes a while.
    "block_place_delay": 0, // delay between placing blocks (ms) if using newAction. helps avoid bot being kicked by anti-cheat mechanisms on servers.

    // Navigation tunables. Pathfind timeout scales with straight-line distance:
    // budget_ms = clamp(base + per_block * distance, base, max)
    "pathfind_timeout_base_ms": 1000,
    "pathfind_timeout_per_block_ms": 30,
    "pathfind_timeout_max_ms": 15000,
    // For long-distance navigation, break the journey into chunks so pathfinder
    // never has to plan more than ~chunk_distance blocks at once.
    "nav_chunk_threshold": 100, // distances >= this are navigated in chunks
    "nav_chunk_distance": 80,   // target chunk size (blocks)
    "nav_chunk_retry_limit": 2, // retries per chunk before giving up that chunk
    "journeymap_bridge_url": "http://127.0.0.1:47892", // optional local JourneyMap companion bridge
    "journeymap_waypoints_path": null, // optional JourneyMap WaypointData.dat file or directory containing waypoint data
    "journeymap_auto_discover_waypoints": true, // search common local JourneyMap instance folders when no path is configured
    "world_id": "local_forge_1_21_11_overworld", // optional canonical id for this Minecraft world. Best way to scope durable map/storage memory.
    "server_path": null, // optional local server root; used to derive world identity from server.properties.
    "world_path": null, // optional direct local world save path; used to derive world identity.
    "load_world_memory": true, // load durable world-scoped MemoryBank facts independently of chat memory
    "warn_on_low_confidence_world_id": true, // chat a warning when durable world identity is only a weak fallback
    "auto_sync_journeymap_on_start": false, // opt-in: import JourneyMap bridge waypoints after world memory loads

    "log_all_prompts": false, // legacy: log ALL prompts to ./bots/{bot}/logs/conversation_*.txt. Superseded by transcript_logging+transcript_include_prompts. Now also gated by legacy_logs_enabled.
    "transcript_logging": true, // append JSONL runtime transcript events to ./bots/{bot}/transcripts
    "transcript_include_prompts": true, // include full prompt bodies in transcript logs (canonical record)
    "transcript_include_code": true, // include generated action code in transcript logs
    "transcript_max_field_chars": 20000, // truncate long transcript fields
    "debug_logging": false, // when true, additionally write high-frequency debug events (pathfinder ticks, mode evaluation churn, placeholder resolution detail) to ./bots/{bot}/debug/<sessionId>.jsonl
    "legacy_logs_enabled": false, // when true, also write legacy ./bots/{bot}/logs/conversation_*.txt and ./bots/{bot}/histories/*.json files (deprecated; transcript_logging is now canonical)
    "transcript_retention_days": 7, // on agent start, prune transcripts/*.jsonl and debug/*.jsonl older than this many days. 0 disables pruning.
    "action_stuck_poll_ms": 10000, // while executing action code: how often to sample for positional/inventory stagnation
    "action_stuck_after_ms": 45000, // emit action.stuck if no notable movement/inventory change for this long during an action
    "task_ledger_enabled": true, // persist current user task and verified progress to bots/{agent}/task_ledger.json
    "task_status_chat_enabled": true, // chat concise task milestone/blocker updates for long-running tasks
    "task_status_heartbeat_ms": 60000, // minimum interval between repeated task progress chat messages
    "task_history_limit": 20, // number of completed/failed tasks to keep in the task ledger history
    "mining_verify_completion": true, // require inventory/storage evidence before declaring mining objectives complete
};

export default settings;
