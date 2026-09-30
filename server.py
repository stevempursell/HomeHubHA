import os
from pathlib import Path
from aiohttp import web, ClientSession, ClientTimeout

PORT = 8099
HA_API = "http://supervisor/core/api"
HA_WS = "ws://supervisor/core/websocket"
TOKEN = os.environ.get("SUPERVISOR_TOKEN", "")
WWW = Path("/app/www")

def ha_headers():
    return {
        "Authorization": `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
    }

async def proxy_get(request):
    path = request.match_info["path"]
    async with ClientSession(timeout=ClientTimeout(total=15)) as session:
        async with session.get(f"{HA_API}/{path}", headers=ha_headers()) as resp:
            body = await resp.read()
            return web.Response(body=body, status=resp.status, content_type=resp.content_type)

async def call_service(request):
    domain = request.match_info["domain"]
    service = request.match_info["service"]
    payload = await request.json()
    async with ClientSession(timeout=ClientTimeout(total=15)) as session:
        async with session.post(
            f"{HA_API}/services/{domain}/{service}",
            headers=ha_headers(),
            json=payload,
        ) as resp:
            body = await resp.read()
            return web.Response(body=body, status=resp.status, content_type=resp.content_type)

async def registry(request):
    if not TOKEN:
        return web.json_response({"error": "SUPERVISOR_TOKEN unavailable"}, status=500)

    async with ClientSession(timeout=ClientTimeout(total=15)) as session:
        async with session.ws_connect(HA_WS) as ws:
            hello = await ws.receive_json()
            if hello.get("type") != "auth_required":
                return web.json_response({"error": "Unexpected HA WebSocket greeting"}, status=502)

            await ws.send_json({"type": "auth", "access_token": TOKEN})
            auth = await ws.receive_json()
            if auth.get("type") != "auth_ok":
                return web.json_response({"error": "Home Assistant WebSocket authentication failed"}, status=401)

            commands = [
                (1, "config/area_registry/list"),
                (2, "config/device_registry/list"),
                (3, "config/entity_registry/list_for_display"),
            ]
            for command_id, command_type in commands:
                await ws.send_json({"id": command_id, "type": command_type})

            results = {}
            while len(results) < len(commands):
                message = await ws.receive_json()
                if message.get("type") == "result" and message.get("id") in {1, 2, 3}:
                    results[message["id"]] = message

            for command_id, label in [(1, "areas"), (2, "devices"), (3, "entities")]:
                if not results[command_id].get("success"):
                    return web.json_response({
                        "error": f"Home Assistant registry request failed: {label}",
                        "detail": results[command_id].get("error"),
                    }, status=502)

            return web.json_response({
                "areas": results[1]["result"],
                "devices": results[2]["result"],
                "entities": results[3]["result"],
            })

async def index(request):
    return web.FileResponse(WWW / "index.html")

app = web.Application()
app.router.add_get("/", index)
app.router.add_get("/api/registry", registry)
app.router.add_get("/api/{path:.*}", proxy_get)
app.router.add_post("/service/{domain}/{service}", call_service)
app.router.add_static("/static/", WWW, show_index=False)

web.run_app(app, host="0.0.0.0", port=PORT)
