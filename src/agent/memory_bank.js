export class MemoryBank {
	constructor() {
		this.memory = this._emptyMemory();
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

	rememberPlace(name, x, y, z) {
		this.remember('places', name, { name, x, y, z });
	}

	recallPlace(name) {
		const place = this.recall('places', name);
		if (!place) return undefined;
		if (Array.isArray(place)) return place;
		return [place.x, place.y, place.z];
	}

	remember(type, key, value) {
		const namespace = this._getNamespace(type, true);
		namespace[key] = this._clone(value);
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

	loadJson(json) {
		const next = this._emptyMemory();
		if (!this._isPlainObject(json)) {
			this.memory = next;
			return;
		}

		const hasTypedNamespaces = ['places', 'journeymap', 'routes', 'storage', 'observations', 'pending']
			.some(key => Object.prototype.hasOwnProperty.call(json, key));

		if (!hasTypedNamespaces) {
			for (const [name, value] of Object.entries(json)) {
				next.places[name] = this._migratePlaceValue(name, value);
			}
			this.memory = next;
			return;
		}

		for (const [key, defaultValue] of Object.entries(next)) {
			if (this._isPlainObject(json[key])) {
				next[key] = this._clone(json[key]);
			} else {
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
		this.memory = next;
	}

	getKeys() {
		return Object.keys(this.memory.places || {}).join(', ')
	}
}
