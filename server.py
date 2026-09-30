\
import os
from pathlib import Path
from aiohttp import web, ClientSession, ClientTimeout

PORT = 8099
HA_API = "http://supervisor/core/api"
TOKEN = os.environ.get("SUPERVISOR_TOKEN", "")
WWW = Path("/app/www")

def ha_headers():
    return {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
    }

async def proxy_get(request):
    path = request.match_info["path"]
    async with ClientSession(timeout=ClientTimeout(total=15)) as session:
        async with session.get(f"{HA_API}/{path}", headers=ha_headers()) as resp:
            body = await resp.read()
            return web.Response(
                body=body,
                status=resp.status,
                content_type=resp.content_type
            )

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
            return web.Response(
                body=body,
                status=resp.status,
                content_type=resp.content_type
            )

async def index(request):
    return web.FileResponse(WWW / "index.html")

app = web.Application()
app.router.add_get("/", index)
app.router.add_get("/api/{path:.*}", proxy_get)
app.router.add_post("/service/{domain}/{service}", call_service)
app.router.add_static("/static/", WWW, show_index=False)

web.run_app(app, host="0.0.0.0", port=PORT)
