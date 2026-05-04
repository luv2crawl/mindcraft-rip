package mindcraft.journeymap;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

/**
 * Minimal localhost HTTP bridge scaffold for JourneyMap API integration.
 *
 * Wire the placeholder methods to TeamJM's journeymap-api in a real Fabric or
 * Forge companion mod. Keep this server bound to loopback only.
 */
public final class JourneyMapBridge {
    private static final int PORT = 47892;
    private HttpServer server;

    public void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", PORT), 0);
        server.createContext("/status", this::status);
        server.createContext("/waypoints", this::waypoints);
        server.createContext("/markers", this::markers);
        server.start();
    }

    public void stop() {
        if (server != null) {
            server.stop(0);
            server = null;
        }
    }

    private void status(HttpExchange exchange) throws IOException {
        if (!"GET".equals(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"ok\":false,\"reason\":\"method_not_allowed\"}");
            return;
        }
        respond(exchange, 200, "{\"ok\":true,\"service\":\"mindcraft-journeymap-bridge\"}");
    }

    private void waypoints(HttpExchange exchange) throws IOException {
        switch (exchange.getRequestMethod()) {
            case "GET" -> respond(exchange, 200, readJourneyMapWaypoints());
            case "POST" -> {
                String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                createJourneyMapWaypoint(body);
                respond(exchange, 200, "{\"ok\":true}");
            }
            default -> respond(exchange, 405, "{\"ok\":false,\"reason\":\"method_not_allowed\"}");
        }
    }

    private void markers(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"ok\":false,\"reason\":\"method_not_allowed\"}");
            return;
        }
        String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        createJourneyMapMarker(body);
        respond(exchange, 200, "{\"ok\":true}");
    }

    private String readJourneyMapWaypoints() {
        return "{\"waypoints\":[]}";
    }

    private void createJourneyMapWaypoint(String json) {
        // TODO: convert JSON into a JourneyMap waypoint through journeymap-api.
    }

    private void createJourneyMapMarker(String json) {
        // TODO: convert JSON into a JourneyMap marker through journeymap-api.
    }

    private void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("content-type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }
}

