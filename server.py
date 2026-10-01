import json
import os
import subprocess
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout, web

PORT = 8099
HA_API = "http://supervisor/core/api"
HA_WS = "ws://supervisor/core/websocket"
TOKEN = os.environ.get("SUPERVISOR_TOKEN", "")
WWW = Path("/app/www")
DATA = Path("/data")
MAPPINGS_FILE = DATA / "room_mappings.json"
OPTIONS_FILE = DATA / "options.json"
ADDONS_ROOT = Path("/addons")

DEFAULT_OPTIONS = {
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


def ha_headers():
    return {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
    }


def load_options():
    options = dict(DEFAULT_OPTIONS)
    try:
        if OPTIONS_FILE.exists():
            loaded = json.loads(OPTIONS_FILE.read_text())
            if isinstance(loaded, dict):
                options.update(loaded)
    except Exception:
        pass
    return options


def find_source_repo():
    candidates = [
        ADDONS_ROOT / "home_hub",
        ADDONS_ROOT / "home-hub",
        ADDONS_ROOT / "HomeHubHA",
    ]

    if ADDONS_ROOT.exists():
        candidates.extend(path for path in ADDONS_ROOT.iterdir() if path.is_dir())

    seen = set()
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if resolved in seen:
            continue
        seen.add(resolved)

        git_dir = resolved / ".git"
        config_file = resolved / "config.yaml"
        if not git_dir.exists() or not config_file.exists():
            continue

        try:
            config_text = config_file.read_text(errors="ignore")
        except OSError:
            continue

        if 'slug: "home_hub"' in config_text or "slug: home_hub" in config_text:
            return resolved

    return None


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
                return web.json_response(
                    {"error": "Home Assistant WebSocket authentication failed"},
                    status=401,
                )

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
                    return web.json_response(
                        {
                            "error": f"Home Assistant registry request failed: {label}",
                            "detail": results[command_id].get("error"),
                        },
                        status=502,
                    )

            return web.json_response(
                {
                    "areas": results[1]["result"],
                    "devices": results[2]["result"],
                    "entities": results[3]["result"],
                }
            )


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

        MAPPINGS_FILE.write_text(
            json.dumps({"entity_rooms": clean}, indent=2, sort_keys=True)
        )
        return web.json_response({"ok": True, "entity_rooms": clean})
    except Exception as err:
        return web.json_response({"error": f"Could not save mappings: {err}"}, status=400)


async def get_options(request):
    return web.json_response(load_options())


async def get_session(request):
    return web.json_response(
        {
            "user_id": request.headers.get("X-Remote-User-Id", ""),
            "user_name": request.headers.get("X-Remote-User-Name", ""),
            "display_name": request.headers.get("X-Remote-User-Display-Name", ""),
        }
    )


async def update_source(request):
    options = load_options()
    if not options.get("enable_source_updater"):
        return web.json_response(
            {"error": "Source updater is disabled in Home Hub configuration."},
            status=403,
        )

    maintenance_user = str(options.get("maintenance_user", "")).strip()
    remote_user = request.headers.get("X-Remote-User-Name", "").strip()

    if not maintenance_user:
        return web.json_response(
            {"error": "Set Maintenance user in Home Hub configuration first."},
            status=403,
        )

    if remote_user != maintenance_user:
        return web.json_response(
            {"error": "This Home Assistant user is not allowed to update Home Hub."},
            status=403,
        )

    repo = find_source_repo()
    if not repo:
        return web.json_response(
            {"error": "Could not find the Home Hub source repository under /addons."},
            status=500,
        )

    try:
        subprocess.run(
            ["git", "config", "--global", "--add", "safe.directory", str(repo)],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )

        commands = [
            ["git", "-C", str(repo), "fetch", "origin"],
            ["git", "-C", str(repo), "reset", "--hard", "origin/main"],
            ["git", "-C", str(repo), "clean", "-fd"],
        ]

        output = []
        for command in commands:
            result = subprocess.run(
                command,
                check=True,
                capture_output=True,
                text=True,
                timeout=45,
            )
            text = (result.stdout or result.stderr).strip()
            if text:
                output.append(text)

        head = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "--short", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()

        return web.json_response(
            {
                "ok": True,
                "head": head,
                "message": "Source updated. Home Assistant should now offer Update if the version changed.",
                "output": output,
            }
        )
    except subprocess.CalledProcessError as err:
        detail = (err.stderr or err.stdout or str(err)).strip()
        return web.json_response({"error": f"Git update failed: {detail}"}, status=500)
    except Exception as err:
        return web.json_response({"error": f"Git update failed: {err}"}, status=500)


async def index(request):
    return web.FileResponse(WWW / "index.html")


app = web.Application()
app.router.add_get("/", index)
app.router.add_get("/api/registry", registry)
app.router.add_get("/api/mappings", get_mappings)
app.router.add_post("/api/mappings", save_mappings)
app.router.add_get("/api/options", get_options)
app.router.add_get("/api/session", get_session)
app.router.add_post("/api/update-source", update_source)
app.router.add_get("/api/{path:.*}", proxy_get)
app.router.add_post("/service/{domain}/{service}", call_service)
app.router.add_static("/static/", WWW, show_index=False)

web.run_app(app, host="0.0.0.0", port=PORT)
