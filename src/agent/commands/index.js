import { getBlockId, getItemId } from "../../utils/mcdata.js";
import { actionsList } from './actions.js';
import { queryList } from './queries.js';

let suppressNoDomainWarning = true;

const commandList = queryList.concat(actionsList);
const commandMap = {};
for (let command of commandList) {
    commandMap[command.name] = command;
}

export function getCommand(name) {
    return commandMap[name];
}

export function blacklistCommands(commands) {
    const unblockable = ['!stop', '!stats', '!inventory', '!goal'];
    for (let command_name of commands) {
        if (unblockable.includes(command_name)){
            console.warn(`Command ${command_name} is unblockable`);
            continue;
        }
        delete commandMap[command_name];
        delete commandList.find(command => command.name === command_name);
    }
}

const commandRegex = /!(\w+)(?:\(((?:-?\d+(?:\.\d+)?|true|false|"[^"]*")(?:\s*,\s*(?:-?\d+(?:\.\d+)?|true|false|"[^"]*"))*)\))?/
const commandGlobalRegex = new RegExp(commandRegex.source, 'g');
const argRegex = /-?\d+(?:\.\d+)?|true|false|"[^"]*"/g;
const MAX_TRANSCRIPT_RESULT_CHARS = 4000;
const COMMAND_RESULT_CODES = {
    OK: 'OK',
    BAD_FORMAT: 'ERR_BAD_FORMAT',
    BAD_ARGS: 'ERR_BAD_ARGS',
    COMMAND_MISSING: 'ERR_COMMAND_MISSING',
    EMPTY_RESULT: 'ERR_EMPTY_RESULT',
    EXCEPTION: 'ERR_EXCEPTION',
    PARTIAL: 'ERR_PARTIAL',
};

export function containsCommand(message) {
    return extractCommandMessages(message)[0]?.commandName ?? null;
}

export function extractCommandMessages(message) {
    const commands = [];
    for (const commandMatch of message.matchAll(commandGlobalRegex)) {
        commands.push({
            commandName: "!" + commandMatch[1],
            commandText: commandMatch[0],
            index: commandMatch.index,
            endIndex: commandMatch.index + commandMatch[0].length
        });
    }
    return commands;
}

export function commandExists(commandName) {
    if (!commandName.startsWith("!"))
        commandName = "!" + commandName;
    return commandMap[commandName] !== undefined;
}

/**
 * Converts a string into a boolean.
 * @param {string} input
 * @returns {boolean | null} the boolean or `null` if it could not be parsed.
 * */
function parseBoolean(input) {
    switch(input.toLowerCase()) {
        case 'false': //These are interpreted as flase;
        case 'f':
        case '0':
        case 'off':
            return false;
        case 'true': //These are interpreted as true;
        case 't':
        case '1':
        case 'on':
            return true;
        default:
            return null;
    }
}

/**
 * @param {number} value - the value to check
 * @param {number} lowerBound
 * @param {number} upperBound
 * @param {string} endpointType - The type of the endpoints represented as a two character string. `'[)'` `'()'` 
 */
function checkInInterval(number, lowerBound, upperBound, endpointType) {
    switch (endpointType) {
        case '[)':
            return lowerBound <= number && number < upperBound;
        case '()':
            return lowerBound < number && number < upperBound;
        case '(]':
            return lowerBound < number && number <= upperBound;
        case '[]':
            return lowerBound <= number && number <= upperBound;
        default:
            throw new Error('Unknown endpoint type:', endpointType)
    }
}



// todo: handle arrays?
/**
 * Returns an object containing the command, the command name, and the comand parameters.
 * If parsing unsuccessful, returns an error message as a string.
 * @param {string} message - A message from a player or language model containing a command.
 * @returns {string | Object}
 */
export function parseCommandMessage(message) {
    const commandMatch = message.match(commandRegex);
    if (!commandMatch) return `Command is incorrectly formatted`;

    const commandName = "!"+commandMatch[1];

    let args;
    if (commandMatch[2]) args = commandMatch[2].match(argRegex);
    else args = [];

    const command = getCommand(commandName);
    if(!command) return `${commandName} is not a command.`

    const params = commandParams(command);
    const paramNames = commandParamNames(command);
    
    if (args.length !== params.length)
        return `Command ${command.name} was given ${args.length} args, but requires ${params.length} args.`;

    
    for (let i = 0; i < args.length; i++) {
        const param = params[i];
        //Remove any extra characters
        let arg = args[i].trim();
        if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
            arg = arg.substring(1, arg.length-1);
        }
        
        //Convert to the correct type
        switch(param.type) {
            case 'int':
                arg = Number.parseInt(arg); break;
            case 'float':
                arg = Number.parseFloat(arg); break;
            case 'boolean':
                arg = parseBoolean(arg); break;
            case 'BlockName':
            case 'BlockOrItemName':
            case 'ItemName':
                if (arg.endsWith('plank') || arg.endsWith('seed'))
                    arg += 's'; // add 's' to for common mistakes like "oak_plank" or "wheat_seed"
            case 'string':
                break;
            default:
                throw new Error(`Command '${commandName}' parameter '${paramNames[i]}' has an unknown type: ${param.type}`);
        }
        if(arg === null || Number.isNaN(arg))
            return `Error: Param '${paramNames[i]}' must be of type ${param.type}.`

        if(typeof arg === 'number') { //Check the domain of numbers
            const domain = param.domain;
            if(domain) {
                /**
                 * Javascript has a built in object for sets but not intervals.
                 * Currently the interval (lowerbound,upperbound] is represented as an Array: `[lowerbound, upperbound, '(]']`
                 */
                if (!domain[2]) domain[2] = '[)'; //By default, lower bound is included. Upper is not.

                if(!checkInInterval(arg, ...domain)) {
                    return `Error: Param '${paramNames[i]}' must be an element of ${domain[2][0]}${domain[0]}, ${domain[1]}${domain[2][1]}.`;
                    //Alternatively arg could be set to the nearest value in the domain.
                }
            } else if (!suppressNoDomainWarning) {
                console.warn(`Command '${commandName}' parameter '${paramNames[i]}' has no domain set. Expect any value [-Infinity, Infinity].`)
                suppressNoDomainWarning = true; //Don't spam console. Only give the warning once.
            }
        } else if(param.type === 'BlockName') { //Check that there is a block with this name
            if(getBlockId(arg) == null) return  `Invalid block type: ${arg}.`
        } else if(param.type === 'ItemName') { //Check that there is an item with this name
            if(getItemId(arg) == null) return `Invalid item type: ${arg}.`
        } else if(param.type === 'BlockOrItemName') {
            if(getBlockId(arg) == null && getItemId(arg) == null) return  `Invalid block or item type: ${arg}.`
        }
        args[i] = arg;
    }
    
    return { commandName, args };
}

export function isAction(name) {
    return actionsList.find(action => action.name === name) !== undefined;
}

/**
 * @param {Object} command
 * @returns {Object[]} The command's parameters.
 */
function commandParams(command) {
    if (!command.params)
        return [];
    return Object.values(command.params);
}

/**
 * @param {Object} command
 * @returns {string[]} The names of the command's parameters.
 */
function commandParamNames(command) {
    if (!command.params)
        return [];
    return Object.keys(command.params);
}

function numParams(command) {
    return commandParams(command).length;
}

function _codeFromReason(reason, ok) {
    if (ok) return COMMAND_RESULT_CODES.OK;
    if (!reason) return COMMAND_RESULT_CODES.EXCEPTION;
    const normalized = String(reason)
        .trim()
        .replace(/^ERR_/i, '')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toUpperCase();
    if (!normalized) return COMMAND_RESULT_CODES.EXCEPTION;
    if (normalized === 'PARTIAL') return COMMAND_RESULT_CODES.PARTIAL;
    return `ERR_${normalized}`;
}

function _classifyLegacyText(text, context = {}) {
    const trimmed = String(text || '').trim();
    if (/^OK:/i.test(trimmed)) return { ok: true, code: COMMAND_RESULT_CODES.OK };
    const failedMatch = trimmed.match(/^FAILED:\s*([^\n]+)/i);
    if (failedMatch) return { ok: false, code: _codeFromReason(failedMatch[1], false) };
    if (/incorrectly formatted/i.test(trimmed)) return { ok: false, code: COMMAND_RESULT_CODES.BAD_FORMAT };
    if (/does not exist|is not a command/i.test(trimmed)) return { ok: false, code: COMMAND_RESULT_CODES.COMMAND_MISSING };
    if (/was given \d+ args|must be of type|must be an element of|invalid (block|item|block or item)/i.test(trimmed)) {
        return { ok: false, code: COMMAND_RESULT_CODES.BAD_ARGS };
    }
    if (/interrupted/i.test(trimmed)) return { ok: false, code: 'ERR_INTERRUPTED' };
    if (/partial/i.test(trimmed)) return { ok: false, code: COMMAND_RESULT_CODES.PARTIAL };
    if (/^Error:/i.test(trimmed)) return { ok: false, code: COMMAND_RESULT_CODES.EXCEPTION };
    return { ok: context.ok ?? null, code: context.code ?? COMMAND_RESULT_CODES.OK };
}

function _summaryFromLegacyText(text) {
    const trimmed = String(text || '').trim();
    const firstLine = trimmed.split('\n').find(line => line.trim().length > 0) || '';
    return firstLine.replace(/^(OK|FAILED):\s*[^\n]+/i, '').trim() || firstLine || 'Command completed.';
}

function _extractNextHints(text) {
    const recommended = String(text || '').match(/^Recommended:\s*(.+)$/im);
    if (!recommended) return [];
    return recommended[1]
        .split(/\s+then\s+/i)
        .map(hint => hint.trim())
        .filter(Boolean);
}

export function normalizeCommandResult(result, context = {}) {
    if (result && typeof result === 'object' && result.__commandResult === true) {
        return {
            ok: result.ok ?? null,
            code: result.code || COMMAND_RESULT_CODES.OK,
            summary: result.summary || '',
            data: result.data || {},
            next_hints: result.next_hints || [],
            raw: result.raw ?? '',
            commandName: result.commandName ?? context.commandName ?? null,
            __commandResult: true,
        };
    }

    if (result && typeof result === 'object' && ('ok' in result || 'reason' in result || 'message' in result)) {
        const ok = result.ok ?? null;
        return {
            ok,
            code: result.code || _codeFromReason(result.reason, ok),
            summary: result.summary || result.message || '',
            data: result.data || {},
            next_hints: result.next_hints || result.recommendedCommands || [],
            raw: result.raw ?? result.message ?? '',
            commandName: context.commandName ?? null,
            __commandResult: true,
        };
    }

    if (result === undefined || result === null || result === '') {
        return {
            ok: false,
            code: COMMAND_RESULT_CODES.EMPTY_RESULT,
            summary: 'Command returned no result.',
            data: {},
            next_hints: [],
            raw: '',
            commandName: context.commandName ?? null,
            __commandResult: true,
        };
    }

    const raw = String(result);
    const classified = _classifyLegacyText(raw, context);
    return {
        ok: classified.ok,
        code: classified.code,
        summary: context.summary || _summaryFromLegacyText(raw),
        data: context.data || {},
        next_hints: context.next_hints || _extractNextHints(raw),
        raw,
        commandName: context.commandName ?? null,
        __commandResult: true,
    };
}

export function renderCommandResult(result) {
    const normalized = normalizeCommandResult(result);
    const raw = String(normalized.raw || '').trim();

    if (raw) {
        if (/^(OK|FAILED):/i.test(raw)) {
            return raw.replace(/^(OK|FAILED):\s*([^\n]+)/i, `${normalized.code}: $2`);
        }
        if (raw.startsWith(normalized.code + ':')) return raw;
        return `${normalized.code}: ${raw}`;
    }

    return `${normalized.code}: ${normalized.summary || 'Command returned no result.'}`;
}

export async function executeCommand(agent, message) {
    let parsed = parseCommandMessage(message);
    if (typeof parsed === 'string') {
        const normalized = normalizeCommandResult(parsed);
        agent.transcript?.record('command.parse.failure', {
            message,
            error: normalized
        }, 'commands');
        return normalized; //The command was incorrectly formatted or an invalid input was given.
    }
    else {
        console.log('parsed command:', parsed);
        agent.transcript?.record('command.parsed', parsed, 'commands');
        const command = getCommand(parsed.commandName);
        let numArgs = 0;
        if (parsed.args) {
            numArgs = parsed.args.length;
        }
        if (numArgs !== numParams(command)) {
            const normalized = normalizeCommandResult(`Command ${command.name} was given ${numArgs} args, but requires ${numParams(command)} args.`, {
                commandName: parsed.commandName,
                code: COMMAND_RESULT_CODES.BAD_ARGS,
                ok: false
            });
            agent.transcript?.record('command.validation.failure', {
                commandName: parsed.commandName,
                given: numArgs,
                required: numParams(command),
                result: normalized
            }, 'commands');
            return normalized;
        }
        else {
            const start = Date.now();
            agent.transcript?.record('command.start', parsed, 'commands');
            try {
                const result = await command.perform(agent, ...parsed.args);
                const normalized = normalizeCommandResult(result, { commandName: parsed.commandName });
                agent.transcript?.record('command.end', {
                    commandName: parsed.commandName,
                    duration_ms: Date.now() - start,
                    result: _truncateTranscriptValue(normalized)
                }, 'commands');
                return normalized;
            } catch (error) {
                const normalized = normalizeCommandResult(error?.message || String(error), {
                    commandName: parsed.commandName,
                    code: COMMAND_RESULT_CODES.EXCEPTION,
                    ok: false
                });
                agent.transcript?.record('command.failure', {
                    commandName: parsed.commandName,
                    duration_ms: Date.now() - start,
                    error: _truncateTranscriptValue(error),
                    result: _truncateTranscriptValue(normalized)
                }, 'commands');
                return normalized;
            }
        }
    }
}

function _truncateTranscriptValue(value) {
    if (value && typeof value === 'object' && value.__commandResult === true) {
        const copy = { ...value };
        copy.raw = _truncateTranscriptValue(copy.raw);
        return copy;
    }
    if (typeof value !== 'string') return value;
    if (value.length <= MAX_TRANSCRIPT_RESULT_CHARS) return value;
    return {
        text: value.slice(0, MAX_TRANSCRIPT_RESULT_CHARS),
        truncated: true,
        original_length: value.length
    };
}

export function getCommandDocs(agent) {
    const typeTranslations = {
        //This was added to keep the prompt the same as before type checks were implemented.
        //If the language model is giving invalid inputs changing this might help.
        'float':             'number',
        'int':               'number',
        'BlockName':         'string',
        'ItemName':          'string',
        'BlockOrItemName':   'string',
        'boolean':           'bool'
    }
    let docs = `\n*COMMAND DOCS\n You can use the following commands to perform actions and get information about the world. 
    Use the commands with the syntax: !commandName or !commandName("arg1", 1.2, ...) if the command takes arguments.\n
    Do not use codeblocks. Use double quotes for strings. Use at most one command in each response; wait for the command result before issuing the next command.
    Command results may start with stable codes like OK, ERR_NO_PATH, ERR_BAD_ARGS, ERR_COMMAND_MISSING, ERR_INTERRUPTED, or ERR_PARTIAL. Use these codes to choose recovery steps.\n`;
    for (let command of commandList) {
        if (agent.blocked_actions.includes(command.name)) {
            continue;
        }
        docs += command.name + ': ' + command.description + '\n';
        if (command.params) {
            docs += 'Params:\n';
            for (let param in command.params) {
                docs += `${param}: (${typeTranslations[command.params[param].type]??command.params[param].type}) ${command.params[param].description}\n`;
            }
        }
    }
    return docs + '*\n';
}
