# JourneyMap Bridge

Optional local companion for Mindcraft JourneyMap integration.

The Node bot expects a localhost-only HTTP bridge at `http://127.0.0.1:47892`
unless `journeymap_bridge_url` is changed in `settings.js`.

Endpoints:

- `GET /status` -> `{ "ok": true }`
- `GET /waypoints` -> `{ "waypoints": [{ "name": "base", "x": 10, "y": 64, "z": -20, "dimension": "overworld" }] }`
- `POST /waypoints` accepts the same waypoint shape.
- `POST /markers` accepts `{ "name", "x", "y", "z", "dimension", "source" }`.

This directory is a small scaffold, not a complete packaged mod. Add the
`JourneyMapBridge.java` source to a Fabric/Forge companion project that depends
on `journeymap-api`, then wire the placeholder `readJourneyMapWaypoints`,
`createJourneyMapWaypoint`, and `createJourneyMapMarker` methods to the current
JourneyMap API calls for your Minecraft/JourneyMap version.

