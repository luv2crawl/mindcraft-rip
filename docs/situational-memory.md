# Situational Memory

This document describes the typed memory layer used for JourneyMap waypoints,
route memory, storage logistics, observations, and pending recovery decisions.

## Memory Shape

`MemoryBank` now stores typed records instead of a flat name-to-coordinate map.
Old memory still loads safely: an old record like this:

```json
{
  "base": [10, 64, -20]
}
```

is migrated to:

```json
{
  "places": {
    "base": { "name": "base", "x": 10, "y": 64, "z": -20 }
  }
}
```

The current top-level namespaces are:

- `places`: named coordinates from commands such as `!rememberHere`.
- `journeymap.waypoints`: waypoints imported from JourneyMap or pasted location strings.
- `routes`: human-approved breadcrumb routes.
- `storage`: labeled and indexed storage blocks.
- `observations`: compact vision summaries captured by explicit/event-triggered observation.
- `pending`: active route recordings and blocked-route recovery issues.

Use these generic methods when adding new typed records:

```js
agent.memory_bank.remember(type, key, value);
agent.memory_bank.recall(type, key);
agent.memory_bank.list(type);
agent.memory_bank.search(type, query);
```

`rememberPlace()` and `recallPlace()` remain for compatibility. `recallPlace()`
still returns `[x, y, z]` because existing mining and navigation code expects
that shape.

## Persistence

Structured world facts are saved separately from bot chat/session memory. The
bot first resolves a world identity from the best available source:

1. `settings.world_id`
2. JourneyMap bridge `/world`, if available
3. `settings.world_path` or `settings.server_path`
4. protocol/server metadata as a low-confidence fallback

Durable world memory is written to:

```text
bots/_worlds/{world_id}/memory.json
```

`History.save()` still writes chat/session state into:

```text
bots/{bot_name}/memory.json
```

Legacy `memory_bank` data in `bots/{bot_name}/memory.json` is migrated into the
world memory file when the resolved identity is high confidence. Corrupt or
missing typed namespaces are repaired to empty objects during load.

This is separate from `History.memory`, the natural-language conversation
summary injected into prompts as `$TEXT_MEMORY` or the text portion of
`$MEMORY`. Structured world facts are injected through `$STRUCTURED_MEMORY` or
the structured portion of `$MEMORY`, and they are not fed back into the
natural-language summary prompt.

## JourneyMap Workflow

JourneyMap v1 integration uses an optional localhost bridge. The bot setting is:

```js
journeymap_bridge_url: "http://127.0.0.1:47892"
auto_sync_journeymap_on_start: false
```

Startup sync is opt-in. When enabled, the bot imports bridge waypoints after
world memory loads, logs `journeymap.startup_sync.*` transcript events, saves
world memory if waypoints changed, and warns in chat only if the bridge is
unavailable.

Commands:

- `!syncJourneyMap`: imports waypoints from the bridge into `journeymap.waypoints`.
- `!importJourneyMapLocation(text)`: imports a pasted shared location string.
- `!journeyMapWaypoints`: lists imported waypoints.
- `!goToWaypoint(name)`: navigates to an imported waypoint.
- `!exportWaypoint(name)`: exports a known place, route endpoint, waypoint, or storage marker to the bridge.

If the bridge is unavailable, commands return a normalized
`ERR_JOURNEYMAP_BRIDGE_UNAVAILABLE` result and recommend
`!importJourneyMapLocation(...)`.

Valid pasted location strings can have reordered fields:

```text
[z:-20, name:base, x:10, dim:0, y:64]
```

`x` and `z` are required. `y`, `dim`, and `name` are optional.

The bridge scaffold lives in:

```text
services/journeymap-bridge/
```

It documents and stubs the expected localhost HTTP contract:

- `GET /status`
- `GET /waypoints`
- `POST /waypoints`
- `POST /markers`

The Java source is intentionally a scaffold. It must be wired to the current
`journeymap-api` calls for the target Minecraft/JourneyMap version.

## Route Memory

Routes are human-approved breadcrumb paths. They are intended for routes through
human-built tunnels, bases, paths, and repeated logistics corridors.

Commands:

- `!startRouteRecording(name)`: starts recording breadcrumbs while the bot moves.
- `!stopRouteRecording`: saves the route with start/end, dimension, timestamps, and breadcrumbs.
- `!followRoute(name)`: follows the route non-destructively.
- `!routeStatus(name)`: reports route length, endpoints, last failure, and linked waypoint count.
- `!continueRoute(name, action)`: resumes a blocked route after explicit approval.

Valid `!continueRoute` actions:

- `retry`
- `skip_segment`
- `allow_dig_once`

Route following never silently digs. If a segment cannot be reached with
non-destructive movement, the bot stops, saves `pending.route_issue`, and reports
recommended recovery commands. `allow_dig_once` applies only to the current
blocked segment and expires immediately after that segment attempt.

Structured route failure reasons are normalized into `ERR_*` command-result
codes before they are fed back into history. Common raw reasons include:

- `route_blocked`
- `no_path`
- `interrupted`
- `dimension_mismatch`
- `waypoint_missing`
- `vision_unavailable`
- `bridge_unavailable`

## Event-Triggered Vision

Vision remains disabled by default through `allow_vision: false`.

Commands and events:

- `!observeHere(reason)` captures one screenshot summary and stores it under `observations`.
- On route failure, if vision is enabled, the bot captures one observation and attaches its key to the pending route issue.

There is no periodic screenshot capture during normal route following.

## Storage Logistics

Storage memory is a stale cache of known containers. Commands must be clear that
results are based on the latest index time.

Commands:

- `!labelNearestStorage(name)`: saves the nearest chest, trapped chest, or barrel.
- `!indexStorage(name)`: opens a labeled storage block and refreshes item counts.
- `!indexStorageArea(place_or_waypoint)`: scans reachable nearby containers around a known location.
- `!findInStorage(item_name)`: reports all indexed containers with matching items.
- `!restockFromStorage(item_name, num)`: navigates to the best indexed container, withdraws up to `num`, and refreshes that container's index.

`!organizeStorage` is intentionally deferred. The v1 storage workflow does not
move items between containers.

## Output Style

New commands use structured objective-style output where possible. The command
dispatcher normalizes that output before the next prompt sees it:

```text
OK: ok
Imported JourneyMap waypoint "base".
Data: x: 10, y: 64, z: -20
```

or:

```text
ERR_ROUTE_BLOCKED: route_blocked
Route "mine_path" is blocked at segment 4. I stopped before digging.
Recommended: !continueRoute("mine_path", "retry") then !continueRoute("mine_path", "skip_segment") then !continueRoute("mine_path", "allow_dig_once")
Data: segment: 4
```

This keeps command results useful both for humans and for the next prompt loop.
