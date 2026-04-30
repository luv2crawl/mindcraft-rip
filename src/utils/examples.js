import { cosineSimilarity } from './math.js';
import { stringifyTurns, wordOverlapScore } from './text.js';

function stripSpeakerPrefix(text) {
    return String(text ?? '').replace(/^[a-zA-Z0-9_ -]{1,32}:\s*/, '');
}

export function normalizeIntentText(text) {
    return stripSpeakerPrefix(text)
        .replace(/\(FROM OTHER BOT\)/gi, ' ')
        .replace(/\b(hi|hey|hello)\b[,\s]*/gi, ' ')
        .replace(/\b(deepseek|assistant|bot|gpt)\b[,\s]*/gi, ' ')
        .replace(/\b(please|pls)\b/gi, ' ')
        .replace(/\b(can|could|would|will)\s+you\b/gi, ' ')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function latestIntentText(turns) {
    const latestUser = [...turns].reverse().find(turn => turn.role === 'user');
    if (latestUser)
        return normalizeIntentText(latestUser.content);

    const latestSystem = [...turns].reverse().find(turn => turn.role === 'system');
    if (latestSystem)
        return normalizeIntentText(latestSystem.content);

    const latestNonAssistant = [...turns].reverse().find(turn => turn.role !== 'assistant');
    return latestNonAssistant ? normalizeIntentText(latestNonAssistant.content) : '';
}

export function exampleIntentText(example) {
    if (example[0]?.role === 'system')
        return normalizeIntentText(example[0].content);

    const firstUser = example.find(turn => turn.role === 'user');
    if (firstUser)
        return normalizeIntentText(firstUser.content);

    const firstSystem = example.find(turn => turn.role === 'system');
    return firstSystem ? normalizeIntentText(firstSystem.content) : '';
}

function exampleIntentRole(example) {
    if (example[0]?.role === 'system')
        return 'system';

    const firstUser = example.find(turn => turn.role === 'user');
    if (firstUser)
        return 'user';

    const firstSystem = example.find(turn => turn.role === 'system');
    return firstSystem ? 'system' : null;
}

function assistantOutputText(example) {
    return example
        .filter(turn => turn.role === 'assistant')
        .map(turn => turn.content)
        .join(' ')
        .trim();
}

export class Examples {
    constructor(model, select_num=2) {
        this.examples = [];
        this.model = model;
        this.select_num = select_num;
        this.embeddings = {};
    }

    exampleIntentText(example) {
        return exampleIntentText(example);
    }

    latestIntentText(turns) {
        return latestIntentText(turns);
    }

    assistantOutputText(example) {
        return assistantOutputText(example);
    }

    fallbackScore(queryText, example) {
        const intent = this.exampleIntentText(example);
        const output = this.assistantOutputText(example);
        const roleBoost = exampleIntentRole(example) === 'user' ? 0.05 : 0;
        return wordOverlapScore(queryText, intent) + (wordOverlapScore(queryText, output) * 0.25) + roleBoost;
    }

    async load(examples) {
        this.examples = examples;
        if (!this.model) return; // Early return if no embedding model
        
        if (this.select_num === 0)
            return;

        try {
            // Create array of promises first
            const embeddingPromises = examples.map(example => {
                const turn_text = this.exampleIntentText(example);
                return this.model.embed(turn_text)
                    .then(embedding => {
                        this.embeddings[turn_text] = embedding;
                    });
            });
            
            // Wait for all embeddings to complete
            await Promise.all(embeddingPromises);
        } catch (err) {
            console.warn('Error with embedding model, using word-overlap instead.');
            this.model = null;
        }
    }

    async getRelevant(turns) {
        if (this.select_num === 0)
            return [];

        let turn_text = this.latestIntentText(turns);
        let ranked = [...this.examples];
        if (this.model !== null) {
            try {
                let embedding = await this.model.embed(turn_text);
                ranked.sort((a, b) => this.embeddingScore(embedding, turn_text, b) - this.embeddingScore(embedding, turn_text, a));
            } catch (err) {
                console.warn('Error with embedding model query, using word-overlap instead.');
                ranked.sort((a, b) => this.fallbackScore(turn_text, b) - this.fallbackScore(turn_text, a));
            }
        }
        else {
            ranked.sort((a, b) => this.fallbackScore(turn_text, b) - this.fallbackScore(turn_text, a));
        }
        let selected = ranked.slice(0, this.select_num);
        return JSON.parse(JSON.stringify(selected)); // deep copy
    }

    embeddingScore(queryEmbedding, queryText, example) {
        const intent = this.exampleIntentText(example);
        const exampleEmbedding = this.embeddings[intent];
        if (!exampleEmbedding)
            return this.fallbackScore(queryText, example);

        const similarity = cosineSimilarity(queryEmbedding, exampleEmbedding);
        if (!Number.isFinite(similarity))
            return this.fallbackScore(queryText, example);

        const roleBoost = exampleIntentRole(example) === 'user' ? 0.05 : 0;
        return similarity + (wordOverlapScore(queryText, this.assistantOutputText(example)) * 0.25) + roleBoost;
    }

    async createExampleMessage(turns) {
        let selected_examples = await this.getRelevant(turns);

        console.log('selected examples:');
        for (let example of selected_examples) {
            console.log(`Example selected: intent="${this.exampleIntentText(example)}" output="${this.assistantOutputText(example)}"`);
        }

        let msg = 'Examples of how to respond:\n';
        for (let i=0; i<selected_examples.length; i++) {
            let example = selected_examples[i];
            msg += `Example ${i+1}:\n${stringifyTurns(example)}\n\n`;
        }
        return msg;
    }
}
