import json
import os
import subprocess
from pathlib import Path
from aiohttp import web, ClientSession, ClientTimeout

PORT = 8099
HA_API = "http://supervisor/core/api"
HA_WS = "ws://supervisor/core/websocket"
TOKEN = os.environ.get("SUPERVISOR_TOKEN", "")
WWW = Path("/app/www")
DATA = Path("/data")
OPTIONS_FILE = DATA / "options.json"
MAPPINGS_FILE = DATA / "room_mappings.json"
ADDONS_ROOT = Path("/addons")


def ha_headers():
    return {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
    }


def read_options():
    defaults = {
        "show_alarm_controls": True,
        "show_room_manager": True,
        "show_diagnostics": False,
        "auto_map_areas": True,
        "auto_map_names": True,
        "show_unavailable_entities": False,
        "alarm_entity": "",
        "enable_source_updater": False,
        "maintenance_user": "",
    }
    try:
        if OPTIONS_FILE.exists():
            saved = json.loads(OPTIONS_FILE.read_text())
            if isinstance(saved, dict):
                defaults.update(saved)
    except Exception:
        pass
    return defaults


async def options(request):
    return web.json_response(read_options())


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


async def get_mappings(request):
    DATA.mkdir(parents=True, exist_ok=True)
    if not MAPPINGS_FILE.exists():
        return web.json_response({"entity_rooms": {}})
    try:
        return web.json_response(json.loads(MAPPINGS_FILE.read_text()))
    except Exception as err:
        return web.json_response({"error": f"Could not read mappings: {err}"}, status=500)


async def save_mappings(request):
    DATA.mkdir(parents=True, exist_ok=True)
    try:
        payload = await request.json()
        entity_rooms = payload.get("entity_rooms", {})
        if not isinstance(entity_rooms, dict):
            raise ValueError("entity_rooms must be an object")
        clean = {}
        for entity_id, room_ids in entity_rooms.items():
            if not isinstance(entity_id, str) or not isinstance(room_ids, list):
                continue
            clean[entity_id] = [str(room_id) for room_id in room_ids]
        MAPPINGS_FILE.write_text(json.dumps({"entity_rooms": clean}, indent=2, sort_keys=True))
        return web.json_response({"ok": True, "entity_rooms": clean})
    except Exception as err:
        return web.json_response({"error": f"Could not save mappings: {err}"}, status=400)


def find_source_repo():
    if not ADDONS_ROOT.exists():
        return None
    candidates = []
    for child in ADDONS_ROOT.iterdir():
        if child.is_dir():
            candidates.append(child)
            try:
                candidates.extend(p for p in child.iterdir() if p.is_dir())
            except OSError:
                pass
    for path in candidates:
        cfg = path / "config.yaml"
        git = path / ".git"
        if not cfg.exists() or not git.exists():
            continue
        try:
            text = cfg.read_text()
        except OSError:
            continue
        if 'slug: "home_hub"' in text or "slug: home_hub" in text:
            return path
    return None


async def source_status(request):
    opts = read_options()
    repo = find_source_repo()
    return web.json_response({
        "enabled": bool(opts.get("enable_source_updater")),
        "repo_found": bool(repo),
        "repo_path": str(repo) if repo else None,
    })


async def source_update(request):
    opts = read_options()
    if not opts.get("enable_source_updater"):
        return web.json_response({"error": "Source updater is disabled in Home Hub Configuration."}, status=403)

    repo = find_source_repo()
    if not repo:
        return web.json_response({"error": "Could not locate the Home Hub git checkout under /addons."}, status=404)

    try:
        fetch = subprocess.run(
            ["git", "-C", str(repo), "fetch", "origin"],
            capture_output=True, text=True, timeout=45
        )
        if fetch.returncode != 0:
            raise RuntimeError(fetch.stderr.strip() or fetch.stdout.strip() or "git fetch failed")

        reset = subprocess.run(
            ["git", "-C", str(repo), "reset", "--hard", "origin/main"],
            capture_output=True, text=True, timeout=45
        )
        if reset.returncode != 0:
            raise RuntimeError(reset.stderr.strip() or reset.stdout.strip() or "git reset failed")

        head = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=10
        )
        return web.json_response({
            "ok": True,
            "message": reset.stdout.strip() or "Home Hub source updated.",
            "commit": head.stdout.strip() if head.returncode == 0 else None,
            "next_step": "Open Settings > Apps > Home Hub and choose Update.",
        })
    except Exception as err:
        return web.json_response({"error": str(err)}, status=500)


async def index(request):
    return web.FileResponse(WWW / "index.html")


app = web.Application()
app.router.add_get("/", index)
app.router.add_get("/api/options", options)
app.router.add_get("/api/registry", registry)
app.router.add_get("/api/mappings", get_mappings)
app.router.add_post("/api/mappings", save_mappings)
app.router.add_get("/api/source/status", source_status)
app.router.add_post("/api/source/update", source_update)
app.router.add_get("/api/{path:.*}", proxy_get)
app.router.add_post("/service/{domain}/{service}", call_service)
app.router.add_static("/static/", WWW, show_index=False)

web.run_app(app, host="0.0.0.0", port=PORT)
