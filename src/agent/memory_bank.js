export class MemoryBank {
	constructor() {
		this.memory = this._emptyMemory();
		this.dirty = false;
	}

	_emptyMemory() {
		return {
			places: {},
			journeymap: {
				waypoints: {},
			},
			routes: {},
			storage: {},
			observations: {},
			pending: {},
		};
	}

	_isPlainObject(value) {
		return value !== null && typeof value === 'object' && !Array.isArray(value);
	}

	_clone(value) {
		return JSON.parse(JSON.stringify(value));
	}

	_normalizeType(type) {
		if (type === 'journeymap.waypoints') return ['journeymap', 'waypoints'];
		return String(type || '').split('.').filter(Boolean);
	}

	_getNamespace(type, create = false) {
		const parts = this._normalizeType(type);
		if (parts.length === 0) return null;
		let cursor = this.memory;
		for (const part of parts) {
			if (!this._isPlainObject(cursor[part])) {
				if (!create) return null;
				cursor[part] = {};
			}
			cursor = cursor[part];
		}
		return cursor;
	}

	_migratePlaceValue(name, value) {
		if (Array.isArray(value)) {
			const [x, y, z] = value;
			return { name, x, y, z };
		}
		if (this._isPlainObject(value)) {
			return { name, ...value };
		}
		return value;
	}

	_looksLikePlaceValue(value) {
		if (Array.isArray(value)) {
			return value.length >= 3
				&& Number.isFinite(Number(value[0]))
				&& Number.isFinite(Number(value[1]))
				&& Number.isFinite(Number(value[2]));
		}
		if (this._isPlainObject(value)) {
			return Number.isFinite(Number(value.x))
				&& Number.isFinite(Number(value.z))
				&& (value.y === undefined || Number.isFinite(Number(value.y)));
		}
		return false;
	}

	rememberPlace(name, x, y, z, extra = {}) {
		this.remember('places', name, { name, x, y, z, ...extra });
	}

	recallPlace(name) {
		const place = this.recall('places', name);
		if (!place) return undefined;
		if (Array.isArray(place)) return place;
		return [place.x, place.y, place.z];
	}

	recallPlaceRecord(name) {
		return this.recall('places', name);
	}

	remember(type, key, value) {
		const namespace = this._getNamespace(type, true);
		namespace[key] = this._clone(value);
		this.dirty = true;
		return namespace[key];
	}

	recall(type, key) {
		const namespace = this._getNamespace(type, false);
		if (!namespace) return undefined;
		const value = namespace[key];
		return value === undefined ? undefined : this._clone(value);
	}

	list(type) {
		const namespace = this._getNamespace(type, false);
		if (!namespace) return {};
		return this._clone(namespace);
	}

	search(type, query) {
		const namespace = this._getNamespace(type, false);
		if (!namespace) return {};
		const needle = String(query || '').toLowerCase();
		const matches = {};
		for (const [key, value] of Object.entries(namespace)) {
			const haystack = `${key} ${JSON.stringify(value)}`.toLowerCase();
			if (haystack.includes(needle)) {
				matches[key] = this._clone(value);
			}
		}
		return matches;
	}

	getJson() {
		return this._clone(this.memory);
	}

	_formatPosition(key, record) {
		const pos = Array.isArray(record)
			? { x: record[0], y: record[1], z: record[2] }
			: record;
		const x = pos?.x;
		const y = pos?.y ?? '?';
		const z = pos?.z;
		if (x === undefined || z === undefined) return key;
		const dim = pos.dimension ?? pos.dim;
		const dimText = dim === undefined || dim === null ? '' : ` dim:${dim}`;
		return `${pos.name || key}(${x},${y},${z}${dimText})`;
	}

	_contextText(context = {}) {
		const parts = [];
		for (const value of Object.values(context || {})) {
			if (value === null || value === undefined) continue;
			if (typeof value === 'string' || typeof value === 'number') {
				parts.push(String(value));
			} else if (Array.isArray(value)) {
				parts.push(value.join(' '));
			} else if (this._isPlainObject(value)) {
				parts.push(JSON.stringify(value));
			}
		}
		return parts.join(' ').toLowerCase();
	}

	_requestedItems(context = {}) {
		const values = [
			context.currentResourceTarget,
			context.currentOreTarget,
			context.currentItemTarget,
			context.currentCommandName,
			context.lastCommandResultCode,
			context.latestMessage,
			context.latestUserMessage,
		].filter(Boolean).join(' ');
		const tokens = new Set(String(values).toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length >= 3));
		for (const container of [context.lastCommandResultData?.missing, context.lastCommandResultData?.need, context.lastCommandResultData?.have]) {
			for (const key of Object.keys(container || {})) tokens.add(String(key).toLowerCase());
		}
		return [...tokens];
	}

	_freshness(record) {
		const times = [
			record?.verifiedAt,
			record?.contentsIndexedAt,
			record?.indexedAt,
			record?.updatedAt,
			record?.importedAt,
			record?.createdAt,
		].map(value => Date.parse(value)).filter(Number.isFinite);
		return times.length ? Math.max(...times) : 0;
	}

	_scoreRecord(key, record, context = {}, type = '') {
		const contextText = this._contextText(context);
		const lowerKey = String(key || '').toLowerCase();
		const haystack = `${lowerKey} ${JSON.stringify(record || {})}`.toLowerCase();
		let score = 0;
		if (['home_chest', 'main_base', 'base'].includes(lowerKey)) score += 100;
		if (contextText && contextText.includes(lowerKey)) score += 80;
		for (const alias of record?.aliases || []) {
			const lowerAlias = String(alias).toLowerCase();
			if (lowerAlias && contextText.includes(lowerAlias)) score += 70;
		}
		for (const token of contextText.split(/[^a-z0-9_:-]+/).filter(t => t.length >= 3)) {
			if (haystack.includes(token)) score += 5;
		}
		if (type === 'storage') {
			const counts = record?.counts || {};
			for (const item of this._requestedItems(context)) {
				if (counts[item] > 0) score += 120;
				else if (Object.keys(counts).some(name => name.toLowerCase().includes(item))) score += 60;
			}
		}
		const objectiveText = JSON.stringify(context.activeObjective || context.activeObjectiveSummary || '').toLowerCase();
		if (objectiveText && (objectiveText.includes(lowerKey) || haystack.includes(objectiveText))) {
			score += type === 'routes' ? 100 : 45;
		}
		if (type === 'routes' && context.currentRoute && String(context.currentRoute).toLowerCase() === lowerKey) {
			score += 120;
		}
		if (String(context.lastCommandResultCode || '').toLowerCase().includes('missing_home_chest')) {
			if (lowerKey === 'home_chest') score += 150;
			if (['main_base', 'base'].includes(lowerKey)) score += 80;
			if (type === 'storage') score += 25;
		}
		if (record?.updatedAt || record?.indexedAt || record?.contentsIndexedAt || record?.verifiedAt) score += 1;
		return score;
	}

	_rankEntries(type, context = {}) {
		return Object.entries(this.list(type) || {})
			.map(([key, record]) => ({ key, record, score: this._scoreRecord(key, record, context, type), freshness: this._freshness(record) }))
			.sort((a, b) => b.score - a.score || b.freshness - a.freshness || a.key.localeCompare(b.key));
	}

	_formatNamedRecords(type, label, limit = 8, context = {}) {
		const entries = this._rankEntries(type, context);
		if (entries.length === 0) return null;
		const shown = entries
			.slice(0, limit);
		if (Array.isArray(context.surfacedMemoryLabels)) {
			context.surfacedMemoryLabels.push(...shown.map(({ key }) => `${type}:${key}`));
		}
		const formatted = shown
			.map(({ key, record }) => this._formatPosition(key, record));
		const suffix = entries.length > limit ? `, +${entries.length - limit} more` : '';
		return `${label}: ${formatted.join(', ')}${suffix}`;
	}

	getPromptSummary(context = {}) {
		context.surfacedMemoryLabels = [];
		const lines = [
			this._formatNamedRecords('places', 'Places', 8, context),
			this._formatNamedRecords('journeymap.waypoints', 'JourneyMap waypoints', 8, context),
			this._formatNamedRecords('storage', 'Storage labels', 8, context),
			this._formatNamedRecords('routes', 'Routes', 8, context),
		].filter(Boolean);
		if (this._isPlainObject(context.sessionMemory)) {
			context.sessionMemory.lastSurfacedMemoryLabels = context.surfacedMemoryLabels.slice(0, 32);
		}
		return lines.join('\n');
	}

	markClean() {
		this.dirty = false;
	}

	isDirty() {
		return this.dirty;
	}

	loadJson(json) {
		const next = this._emptyMemory();
		if (!this._isPlainObject(json)) {
			this.memory = next;
			this.markClean();
			return;
		}

		const hasTypedNamespaces = ['places', 'journeymap', 'routes', 'storage', 'observations', 'pending']
			.some(key => Object.prototype.hasOwnProperty.call(json, key));

		if (!hasTypedNamespaces) {
			for (const [name, value] of Object.entries(json)) {
				if (this._looksLikePlaceValue(value)) {
					next.places[name] = this._migratePlaceValue(name, value);
				}
			}
			this.memory = next;
			this.markClean();
			return;
		}

		for (const [key, value] of Object.entries(json)) {
			if (this._isPlainObject(value)) {
				next[key] = this._clone(value);
			}
		}
		for (const [key, defaultValue] of Object.entries(this._emptyMemory())) {
			if (!this._isPlainObject(next[key])) {
				next[key] = defaultValue;
			}
		}
		if (!this._isPlainObject(next.journeymap)) next.journeymap = { waypoints: {} };
		if (!this._isPlainObject(next.journeymap.waypoints)) next.journeymap.waypoints = {};
		if (this._isPlainObject(next.places)) {
			for (const [name, value] of Object.entries(next.places)) {
				next.places[name] = this._migratePlaceValue(name, value);
			}
		}
		if (this._isPlainObject(next.storage)) {
			for (const record of Object.values(next.storage)) {
				if (this._isPlainObject(record) && record.indexedAt && !record.contentsIndexedAt) {
					record.contentsIndexedAt = record.indexedAt;
				}
			}
		}
		this.memory = next;
		this.markClean();
	}

	getKeys() {
		return Object.keys(this.memory.places || {}).join(', ')
	}
}
