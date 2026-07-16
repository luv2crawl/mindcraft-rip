import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, extractCommandMessages, isAction, blacklistCommands, normalizeCommandResult, renderCommandResult } from './commands/index.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import { log, validateNameFormat, handleDisconnection, parseKickReason } from './connection_handler.js';
import { appendFileSync } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { TranscriptLogger, pruneOldTranscripts } from './transcript_logger.js';
import { ObjectiveStack } from './objectives/objective_stack.js';
import { resolveWorldIdentity } from './world_identity.js';
import { loadWorldMemory, saveWorldMemory } from './world_memory.js';
import { fetchJourneyMapWaypoints, mergeJourneyMapWaypoints } from './journeymap.js';
import { createSessionMemory, noteCommandResult, noteCommandStart, noteUserIntent } from './session_memory.js';
import { TaskLedger } from './task_ledger.js';

function _configuredMaxCommands() {
    if (settings.max_commands === -1) return Infinity;
    if (settings.max_commands === undefined || settings.max_commands === null) return 1;
    return settings.max_commands;
}

function _normalizeMaxResponses(max_responses) {
    if (max_responses === -1) return Infinity;
    return max_responses;
}

export function resolveMaxResponses({ requestedMaxResponses, selfPrompt, objective }) {
    if (requestedMaxResponses !== null && requestedMaxResponses !== undefined) {
        return _normalizeMaxResponses(requestedMaxResponses);
    }

    const configured = _configuredMaxCommands();
    if (!selfPrompt) {
        return Math.min(configured, 1);
    }

    const activeObjectiveStates = new Set(['running', 'in_progress', 'pending']);
    if (objective && activeObjectiveStates.has(objective.status)) {
        return configured;
    }

    return Math.min(configured, 1);
}

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.count_id = count_id;
        this._disconnectHandled = false;
        this._messageQueue = Promise.resolve();

        // Initialize components
        this.actions = new ActionManager(this);
        this.objectives = new ObjectiveStack(this);
        this.session_memory = createSessionMemory();
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        this.transcript = new TranscriptLogger(this.name || 'unknown');
        this.task_ledger = new TaskLedger(this.name || 'unknown', this).load();
        pruneOldTranscripts(this.name || 'unknown', settings.transcript_retention_days);
        this.transcript.record('agent.start', {
            load_mem,
            init_message,
            count_id,
            profile_name: settings.profile?.name,
            model: settings.profile?.model
        }, 'agent', { stage: 'system' });
        if (serverProxy.connected) {
            const sock = serverProxy.getSocket();
            if (sock) {
                this.transcript.setRelayHook(({ entry, debug }) => {
                    try {
                        sock.emit('transcript-event', {
                            agent: this.name,
                            sessionId: this.transcript.sessionId,
                            entry,
                            debug,
                        });
                    } catch {
                        /* never break logging */
                    }
                });
            }
        }
        console.log(`Initializing agent ${this.name}...`);
        
        // Validate Name Format
        // connection_handler now ensures the message has [LoginGuard] prefix
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }
        
        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.session_memory = createSessionMemory();
        this.self_prompter = new SelfPrompter(this);
        convoManager.initAgent(this);
        await this.prompter.initExamples();

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = blacklistCommands(settings.blocked_actions.concat(this.task.blocked_actions || []));

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);
        this.bot.mindcraft_agent = this;
        
        // Connection Handler
        const onDisconnect = (event, reason) => {
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;

            // Log and Analyze
            // handleDisconnection handles logging to console and server
            const { type } = handleDisconnection(this.name, reason);
            if (event === 'Kicked') {
                const kick = parseKickReason(reason);
                this.transcript?.record('connection.kicked', {
                    raw_reason: reason,
                    parsed_category: kick.type,
                    is_fatal: kick.isFatal,
                    last_pos: this.bot?.entity?.position ?? null,
                }, 'agent', { stage: 'connection' });
            }
            this.transcript?.record('agent.disconnect', {
                event,
                type,
                reason
            }, 'agent', { stage: 'connection' });
     
            process.exit(1);
        };
        
        // Bind events
        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        this.bot.on('error', (err) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                onDisconnect('Error', err);
            } else {
                log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
                this.transcript?.record('connection.error', {
                    message: err?.message ?? String(err),
                    code: err?.code,
                    stack: err?.stack,
                    last_pos: this.bot?.entity?.position ?? null,
                }, 'agent', { stage: 'connection' });
            }
        });

        initModes(this);

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            this.transcript?.record('agent.login', {}, 'agent', { stage: 'connection' });
            serverProxy.login();
            
            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            if (this.prompter.profile.skin)
                this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
            else
                this.bot.chat(`/skin clear`);
        });
		const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                addBrowserViewer(this.bot, count_id);
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                
                console.log(`${this.name} spawned.`);
                this.transcript?.record('agent.spawn', {
                    load_mem,
                    init_message,
                    count_id
                }, 'agent', { stage: 'system' });
                this.clearBotLogs();

                await this._initializeWorldMemory(save_data);
              
                this._setupEventHandlers(save_data, init_message);
                this.startEvents();
              
                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });
    }

    async _initializeWorldMemory(save_data = null) {
        if (settings.load_world_memory === false) {
            this.transcript?.record('world_memory.disabled', {}, 'world_memory', { stage: 'memory' });
            return;
        }
        this.world_identity = await resolveWorldIdentity(this);
        loadWorldMemory(this, this.world_identity, {
            legacyMemoryBank: save_data?.memory_bank || null,
        });
        await this._syncJourneyMapOnStart();
        const confidence = this.world_identity?.confidence;
        if (confidence === 'low' && settings.warn_on_low_confidence_world_id !== false) {
            this.openChat(`World memory is temporary because only a low-confidence world id was available (${this.world_identity.source}). Set world_id in settings to persist saved places/storage safely.`);
        } else if (confidence === 'temporary') {
            this.openChat('I could not determine a durable world id, so map/storage memory is temporary for this session. Set world_id in settings to persist it safely.');
        }
    }

    async _syncJourneyMapOnStart() {
        if (settings.auto_sync_journeymap_on_start !== true) {
            this.transcript?.record('journeymap.startup_sync.skipped', {
                enabled: false,
            }, 'journeymap', { stage: 'memory' });
            return;
        }

        this.transcript?.record('journeymap.startup_sync.start', {
            bridge_url: settings.journeymap_bridge_url,
            waypoints_path: settings.journeymap_waypoints_path || settings.journeymap_data_path || null,
            world_id: this.world_identity?.world_id,
        }, 'journeymap', { stage: 'memory' });
        try {
            const fetched = await fetchJourneyMapWaypoints();
            const stats = mergeJourneyMapWaypoints(this.memory_bank, fetched.waypoints, {
                source: `${fetched.source}_startup`,
            });
            if (this.memory_bank?.isDirty?.()) {
                saveWorldMemory(this);
            }
            this.transcript?.record('journeymap.startup_sync.success', {
                ...stats,
                source: fetched.source,
                sources: fetched.sources,
                world_id: this.world_identity?.world_id,
            }, 'journeymap', { stage: 'memory' });
        } catch (error) {
            this.transcript?.record('journeymap.startup_sync.failure', {
                error: error?.message || String(error),
                bridge_error: error?.bridgeError?.message,
                world_id: this.world_identity?.world_id,
            }, 'journeymap', { stage: 'memory' });
            this.openChat('JourneyMap startup sync is enabled, but sync is unavailable. Existing world memory still loaded; configure journeymap_waypoints_path, use !syncJourneyMap later, or paste a JourneyMap location.');
        }
    }

    _commandMetadata(commandText) {
        const commandName = String(commandText || '').match(/!(\w+)/)?.[0] || null;
        if (!commandName) return {};
        const args = [...String(commandText || '').matchAll(/"([^"]*)"|-?\d+(?:\.\d+)?|true|false/g)]
            .map(match => match[1] ?? match[0]);
        const [firstArg] = args;
        const resourceCommands = new Set([
            '!mineOre',
            '!planMiningRun',
            '!prepareMiningRun',
            '!findInStorage',
            '!restockFromStorage',
            '!takeFromChest',
            '!depositAll',
            '!craftRecipe',
            '!getCraftingPlan',
            '!gatherForRecipe',
            '!collectBlocks',
        ]);
        return {
            args,
            resourceTarget: resourceCommands.has(commandName) && typeof firstArg === 'string'
                ? firstArg
                : null,
        };
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const respondFunc = async (username, message) => {
            if (message === "") return;
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);
                this.transcript?.record('message.inbound.raw', {
                    source: username,
                    message
                }, 'agent', { stage: 'inbound' });

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??')
                }
                else {
                    let translation = await handleEnglishTranslation(message);
                    this.transcript?.record('message.inbound.translated', {
                        source: username,
                        original: message,
                        message: translation
                    }, 'agent', { stage: 'inbound' });
                    this._queueHandleMessage(username, translation);
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }

		this.respondFunc = respondFunc;

        this.bot.on('whisper', respondFunc);
        
        this.bot.on('chat', (username, message) => {
            if (serverProxy.getNumOtherAgents() > 0) return;
            // only respond to open chat messages when there are no other agents
            respondFunc(username, message);
        });

        // Set up auto-eat
        this.bot.autoEat.options = {
            priority: 'foodPoints',
            startAt: 14,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        };

        if (save_data?.self_prompt) {
            if (init_message) {
                this.history.add('system', init_message);
            }
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message) {
            await this.handleMessage('system', init_message, 2);
        }
        else {
            this.openChat("Hello world! I am "+this.name);
        }
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    async handleMessage(source, message, max_responses=null) {
        if (!this._messageQueue) {
            this._messageQueue = Promise.resolve();
        }
        const run = () => this._handleMessage(source, message, max_responses);
        const next = this._messageQueue.then(run, run);
        this._messageQueue = next.catch(() => {});
        return next;
    }

    _queueHandleMessage(source, message, max_responses=null) {
        void this.handleMessage(source, message, max_responses).catch(error => {
            console.error('Queued handleMessage failed:', error?.message || error);
            this.transcript?.record?.('message.handle.unhandled_error', {
                source,
                error: error?.message || String(error),
            }, 'agent', { stage: 'inbound' });
        });
    }

    async _handleMessage(source, message, max_responses=null) {
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }
        const traceId = randomUUID();
        this.transcript?.setTraceContext?.(traceId);
        try {
        this.transcript?.record('message.handle.start', {
            source,
            message,
            max_responses
        }, 'agent', { stage: 'inbound' });

        let used_command = false;
        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);
        max_responses = resolveMaxResponses({
            requestedMaxResponses: max_responses,
            selfPrompt: self_prompt,
            objective: this.objectives?.peek?.()
        });

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name, this)) {
                    noteCommandResult(this, user_command_name, normalizeCommandResult(`Command ${user_command_name} does not exist.`, {
                        commandName: user_command_name,
                        code: 'ERR_COMMAND_MISSING',
                        ok: false
                    }));
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    this.transcript?.record('message.handle.end', {
                        source,
                        used_command: false,
                        early_exit: 'missing_forced_command'
                    }, 'agent', { stage: 'inbound' });
                    return false;
                }
                this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    // all user-initiated commands are ignored by the bot except for this one
                    // add the preceding message to the history to give context for newAction
                    this.history.add(source, message);
                }
                const metadata = this._commandMetadata(message);
                noteCommandStart(this, user_command_name, metadata);
                const forcedCommand = extractCommandMessages(message).find(command => command.commandName === user_command_name);
                let execute_res = await executeCommand(this, forcedCommand?.commandText || message);
                noteCommandResult(this, user_command_name, execute_res, metadata);
                if (execute_res && execute_res.code !== 'ERR_EMPTY_RESULT') 
                    this.routeResponse(source, renderCommandResult(execute_res));
                if (user_command_name === '!newAction' || this.memory_bank?.isDirty?.()) {
                    await this.history.save();
                }
                this.transcript?.record('message.handle.end', {
                    source,
                    used_command: true,
                    forced_command: user_command_name
                }, 'agent', { stage: 'inbound' });
                return true;
            }
        }

        if (from_other_bot)
            this.last_sender = source;

        // Now translate the message
        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);
        this.transcript?.record('message.prompt.input', {
            source,
            message,
            self_prompt,
            from_other_bot
        }, 'agent', { stage: 'inbound' });
        if (!self_prompt && !from_other_bot) {
            noteUserIntent(this, message);
        }

        const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up || convoManager.responseScheduledFor(source);
        
        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            await this.history.add('system', behavior_log);
        }

        // Handle other user messages
        await this.history.add(source, message);
        await this.history.save();

        if (!self_prompt && this.self_prompter.isActive()) // message is from user during self-prompting
            max_responses = 1; // force only respond to this message, then let self-prompting take over
        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;
            let history = this.history.getHistory();
            let res = await this.prompter.promptConvo(history);

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (res.trim().length === 0) {
                console.warn('no response')
                this.transcript?.record('message.no_response', {
                    source
                }, 'agent', { stage: 'model' });
                break; // empty response ends loop
            }

            let command_messages = extractCommandMessages(res);

            if (command_messages.length > 0) { // contains query or command
                this.history.add(this.name, res);

                let stop_loop = false;
                for (let j=0; j<command_messages.length; j++) {
                    const command_message = command_messages[j];
                    const command_name = command_message.commandName;
                    
                    if (!commandExists(command_name, this)) {
                        this.history.add('system', renderCommandResult(normalizeCommandResult(`Command ${command_name} does not exist.`, {
                            commandName: command_name,
                            code: 'ERR_COMMAND_MISSING',
                            ok: false
                        })));
                        noteCommandResult(this, command_name, normalizeCommandResult(`Command ${command_name} does not exist.`, {
                            commandName: command_name,
                            code: 'ERR_COMMAND_MISSING',
                            ok: false
                        }));
                        console.warn('Agent hallucinated command:', command_name)
                        this.transcript?.record('command.hallucinated', {
                            command_name,
                            response: res
                        }, 'agent', { stage: 'command' });
                        continue;
                    }

                    if (checkInterrupt()) {
                        stop_loop = true;
                        break;
                    }
                    this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                    const pre_message = j === 0 ? res.substring(0, command_message.index).trim() : '';
                    if (settings.show_command_syntax === "full") {
                        let chat_message = command_message.commandText;
                        if (pre_message.length > 0)
                            chat_message = `${pre_message}  ${chat_message}`;
                        this.routeResponse(source, chat_message);
                    }
                    else if (settings.show_command_syntax === "shortened") {
                        // show only "used !commandname"
                        let chat_message = `*used ${command_name.substring(1)}*`;
                        if (pre_message.length > 0)
                            chat_message = `${pre_message}  ${chat_message}`;
                        this.routeResponse(source, chat_message);
                    }
                    else {
                        // no command at all
                        if (pre_message.trim().length > 0)
                            this.routeResponse(source, pre_message);
                    }

                    const metadata = this._commandMetadata(command_message.commandText);
                    noteCommandStart(this, command_name, metadata);
                    let execute_res = await executeCommand(this, command_message.commandText);
                    noteCommandResult(this, command_name, execute_res, metadata);
                    let rendered_execute_res = renderCommandResult(execute_res);

                    console.log('Agent executed:', command_name, 'and got:', rendered_execute_res);
                    used_command = true;

                    if (execute_res?.code === 'ERR_EMPTY_RESULT') {
                        stop_loop = true;
                        break;
                    }
                    else {
                        this.history.add('system', rendered_execute_res);
                    }
                }

                if (stop_loop)
                    break;
            }
            else { // conversation response
                this.history.add(this.name, res);
                this.routeResponse(source, res);
                break;
            }
            
            await this.history.save();
        }

        this.transcript?.record('message.handle.end', {
            source,
            used_command
        }, 'agent', { stage: 'inbound' });
        return used_command;
        } finally {
            this.transcript?.clearTraceContext?.();
        }
    }

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            // this is for when the agent is prompted by system while still in conversation
            // so it can respond to events like death but be routed back to the last sender
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // if we're in an ongoing conversation with the other bot, send the response to it
            convoManager.sendToBot(to_player, message);
        }
        else {
            // otherwise, use open chat
            this.openChat(message);
            // note that to_player could be another bot, but if we get here the conversation has ended
        }
    }

    async openChat(message) {
        const originalMessage = message;
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) { // don't translate the command
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
            this.transcript?.record('message.outbound', {
                original: originalMessage,
                translated: message,
                recipients: settings.only_chat_with,
                chat_ingame: false,
                speak: false
            }, 'agent', { stage: 'outbound' });
        }
        else {
            if (settings.speak) {
                speak(to_translate, this.prompter.profile.speak_model);
            }
            if (settings.chat_ingame) {this.bot.chat(message);}
            sendOutputToServer(this.name, message);
            this.transcript?.record('message.outbound', {
                original: originalMessage,
                translated: message,
                chat_ingame: settings.chat_ingame,
                speak: settings.speak
            }, 'agent', { stage: 'outbound' });
        }
    }

    startEvents() {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
            }
            prev_health = this.bot.health;
        });
        const pathApproxDist = () => {
            const goal = this.bot.pathfinder?.goal;
            if (!goal || typeof goal.x !== 'number')
                return null;
            if (!this.bot.entity?.position)
                return null;
            return this.bot.entity.position.distanceTo({
                x: goal.x,
                y: goal.y,
                z: goal.z,
            });
        };

        this.bot.on('path_update', (results) => {
            this.transcript?.record('pathfinder.path_update', {
                status: results?.status ?? null,
                path_length: results?.path?.length ?? 0,
                compute_time_ms: results?.time ?? results?.milliseconds ?? undefined,
            }, 'agent', { stage: 'pathfinder', debug: true });
            const st = results?.status;
            if (st === 'noPath' || st === 'timeout') {
                this.transcript?.record(st === 'noPath' ? 'pathfinder.no_path' : 'pathfinder.timeout', {
                    status: st,
                    path_length: results?.path?.length ?? 0,
                }, 'agent', { stage: 'pathfinder' });
            }
        });
        this.bot.on('goal_reached', () => {
            this.transcript?.record('pathfinder.goal_reached', {
                dist_approx: pathApproxDist(),
            }, 'agent', { stage: 'pathfinder' });
        });
        this.bot.on('path_reset', (reason) => {
            this.transcript?.record('pathfinder.path_reset', {
                reason: reason != null ? String(reason) : null,
            }, 'agent', { stage: 'pathfinder', debug: true });
        });
        let lastPfProgEmit = 0;
        const pfProgEveryMs = 2000;
        setInterval(() => {
            try {
                if (!this.bot.pathfinder?.goal || !this.actions.executing)
                    return;
                const now = Date.now();
                if (now - lastPfProgEmit < pfProgEveryMs)
                    return;
                lastPfProgEmit = now;
                const p = this.bot.entity?.position;
                this.transcript?.record('pathfinder.progress', {
                    pos: p
                        ? { x: p.x, y: p.y, z: p.z }
                        : null,
                    dist_remaining: pathApproxDist(),
                    moving: !!(this.bot.pathfinder.isMoving && this.bot.pathfinder.isMoving()),
                }, 'agent', { stage: 'pathfinder', debug: true });
            } catch (_) { /* noop */ }
        }, pfProgEveryMs).unref?.();

        setInterval(() => {
            try {
                const ping = this.bot.players[this.bot.username]?.ping;
                if (ping != null) {
                    this.transcript?.record('connection.latency', { rtt_ms: ping }, 'agent', { stage: 'connection', debug: true });
                }
            } catch (_) { /* noop */ }
        }, 45000).unref?.();

        // Use connection handler for runtime disconnects
        this.bot.on('end', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('death', () => {
            this.actions.cancelResume();
            this.actions.stop();
        });
        this.bot.on('kicked', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                }
                let dimention = this.bot.game.dimension;
                this._queueHandleMessage('system', `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned.`);
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            setTimeout(() => {
                if (this.isIdle()) {
                    this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    async update(delta) {
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        await this.checkTaskDone();
    }

    isIdle() {
        return !this.actions.executing;
    }
    

    cleanKill(msg='Killing agent process...', code=1) {
        // #region agent log
        fetch('http://127.0.0.1:7484/ingest/810ac7de-41e1-41cb-943b-25180aa7a274',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'99e7db'},body:JSON.stringify({sessionId:'99e7db',location:'agent.js:cleanKill',message:'cleanKill invoked',data:{msg:String(msg),code,stackPreview:(new Error('cleanKill trace')).stack?.split('\n').slice(0,10).join('|')},timestamp:Date.now(),hypothesisId:'H3'})}).catch(()=>{});
        try {
            appendFileSync(path.join(process.cwd(), 'debug-99e7db.log'), `${JSON.stringify({sessionId:'99e7db',location:'agent.js:cleanKill',message:'cleanKill',data:{msg:String(msg),code,stackPreview:(new Error('cleanKill trace')).stack?.split('\n').slice(0,10).join('|')},timestamp:Date.now(),hypothesisId:'H3'})}\n`);
        } catch {
            /* ignore */
        }
        // #endregion
        this.history.add('system', msg);
        this.bot.chat(code > 1 ? 'Restarting.': 'Exiting.');
        this.history.save();
        this.transcript?.record('agent.clean_kill', {
            msg,
            code
        }, 'agent', { stage: 'system' });
        this.transcript?.flushSync?.();
        process.exit(code);
    }
    async checkTaskDone() {
        if (this.task.data) {
            let res = this.task.isDone();
            if (res) {
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 second for save to complete
                console.log('Task finished:', res.message);
                this.transcript?.record('task.finished', res, 'agent', { stage: 'system' });
                this.killAll();
            }
        }
    }

    killAll() {
        serverProxy.shutdown();
    }
}
