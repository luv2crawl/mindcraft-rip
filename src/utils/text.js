export function stringifyTurns(turns) {
    let res = '';
    for (let turn of turns) {
        if (turn.role === 'assistant') {
            res += `\nYour output:\n${turn.content}`;
        } else if (turn.role === 'system') {
            res += `\nSystem output: ${turn.content}`;
        } else {
            res += `\nUser input: ${turn.content}`;
        
        }
    }
    return res.trim();
}

export function toSinglePrompt(turns, system=null, stop_seq='***', model_nickname='assistant') {
    let prompt = system ? `${system}${stop_seq}` : '';
    let role = '';
    turns.forEach((message) => {
        role = message.role;
        if (role === 'assistant') role = model_nickname;
        prompt += `${role}: ${message.content}${stop_seq}`;
    });
    if (role !== model_nickname) // if the last message was from the user/system, add a prompt for the model. otherwise, pretend we are extending the model's own message
        prompt += model_nickname + ": ";
    return prompt;
}

const STOPWORDS = new Set([
    '', 'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
    'i', 'im', 'in', 'into', 'is', 'it', 'me', 'my', 'of', 'on', 'or',
    'our', 'some', 'that', 'the', 'there', 'this', 'to', 'up', 'we',
    'what', 'with', 'you', 'your',
    'bot', 'assistant', 'deepseek', 'gpt',
    'can', 'could', 'would', 'will', 'please', 'pls', 'hey', 'hi',
    'hello', 'sure', 'okay', 'ok', 'alright', 'thanks', 'thank'
]);

const DOMAIN_KEYWORDS = new Set([
    'attack', 'build', 'chest', 'collect', 'come', 'cook', 'craft',
    'deposit', 'diamond', 'diamonds', 'dirt', 'follow', 'go', 'gold',
    'house', 'iron', 'kill', 'look', 'mine', 'mining', 'ore', 'pickaxe',
    'plan', 'plank', 'prepare', 'ready', 'sand', 'stone', 'stop', 'tool',
    'trade', 'walk', 'wood', 'zombie'
]);

function _getWords(text) {
    const tokens = String(text ?? '')
        .toLowerCase()
        .match(/[a-z0-9_]+/g) ?? [];
    const words = new Set();

    for (const token of tokens) {
        const parts = token.split('_').filter(Boolean);
        const hasDomainPart = parts.some(part => DOMAIN_KEYWORDS.has(part));
        if (token.includes('_') && !hasDomainPart)
            continue;

        for (const part of parts) {
            if (!STOPWORDS.has(part))
                words.add(part);
        }
    }
    return [...words];
}

export function wordOverlapScore(text1, text2) {
    const words1 = _getWords(text1);
    const words2 = _getWords(text2);
    if (words1.length === 0 || words2.length === 0)
        return 0;

    const wordSet2 = new Set(words2);
    const intersection = words1.filter(word => wordSet2.has(word));
    const unionSize = new Set([...words1, ...words2]).size;
    const baseScore = intersection.length / unionSize;
    const domainMatches = intersection.filter(word => DOMAIN_KEYWORDS.has(word)).length;
    return baseScore + (domainMatches * 0.1);
}

// ensures stricter turn order and roles:
// - system messages are treated as user messages and prefixed with SYSTEM:
// - combines repeated messages from users
// - separates repeat assistant messages with filler user messages
export function strictFormat(turns) {
    let prev_role = null;
    let messages = [];
    let filler = {role: 'user', content: '_'};
    for (let msg of turns) {
        if (typeof msg.content === 'string')  {
            msg.content = msg.content.trim();
        }
        if (msg.role === 'system') {
            msg.role = 'user';
            msg.content = 'SYSTEM: ' + msg.content;
        }
        if (msg.role === prev_role && msg.role === 'assistant') {
            // insert empty user message to separate assistant messages
            messages.push(filler);
            messages.push(msg);
        }
        else if (msg.role === prev_role) {
            // combine new message with previous message instead of adding a new one
            messages[messages.length-1].content += '\n' + msg.content;
        }
        else {
            messages.push(msg);
        }
        prev_role = msg.role;
        
    }
    if (messages.length > 0 && messages[0].role !== 'user') {
        messages.unshift(filler); // anthropic requires user message to start
    }
    if (messages.length === 0) {
        messages.push(filler);
    }
    return messages;
}
