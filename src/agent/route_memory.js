import Vec3 from 'vec3';

export const ROUTE_FAILURE_REASONS = new Set([
    'route_blocked',
    'no_path',
    'interrupted',
    'dimension_mismatch',
    'waypoint_missing',
    'vision_unavailable',
    'bridge_unavailable',
]);

export function currentPositionRecord(bot) {
    const pos = bot.entity.position;
    return {
        x: Math.round(pos.x * 100) / 100,
        y: Math.round(pos.y * 100) / 100,
        z: Math.round(pos.z * 100) / 100,
        dimension: bot.game?.dimension ?? null,
        t: new Date().toISOString(),
    };
}

export function shouldRecordBreadcrumb(previous, next, minDistance = 2) {
    if (!previous) return true;
    const a = new Vec3(previous.x, previous.y, previous.z);
    const b = new Vec3(next.x, next.y, next.z);
    return a.distanceTo(b) >= minDistance;
}

export function buildRouteRecord(name, breadcrumbs, dimension = null, extra = {}) {
    const points = [...(breadcrumbs || [])];
    const now = new Date().toISOString();
    return {
        name,
        breadcrumbs: points,
        start: points[0] || null,
        end: points[points.length - 1] || null,
        dimension,
        createdAt: extra.createdAt || now,
        updatedAt: extra.updatedAt || now,
        verifiedAt: extra.verifiedAt || null,
        source: extra.source || 'route_recording',
        lastFailure: extra.lastFailure || null,
        linkedWaypoints: extra.linkedWaypoints || [],
    };
}

export function summarizeRoute(route) {
    if (!route) return null;
    return {
        name: route.name,
        length: route.breadcrumbs?.length || 0,
        start: route.start ? `(${route.start.x}, ${route.start.y}, ${route.start.z})` : 'unknown',
        end: route.end ? `(${route.end.x}, ${route.end.y}, ${route.end.z})` : 'unknown',
        dimension: route.dimension || 'unknown',
        lastFailure: route.lastFailure?.reason || 'none',
        linkedWaypoints: route.linkedWaypoints?.length || 0,
    };
}

export function makeRouteIssue(routeName, segmentIndex, reason, data = {}) {
    return {
        type: 'route_issue',
        routeName,
        segmentIndex,
        reason: ROUTE_FAILURE_REASONS.has(reason) ? reason : 'route_blocked',
        data,
        createdAt: new Date().toISOString(),
    };
}
