let states = [];
let registry = null;
let rooms = new Map();
let selectedRoomId = null;

const $ = (id) => document.getElementById(id);

const ROOM_DEFS = [
  { id: "patio", label: "Covered Patio", aliases: ["covered patio", "patio", "back patio"], x: 3, y: 1, w: 51, h: 9 },
  { id: "primary", label: "Primary Bedroom", aliases: ["master bedroom", "primary bedroom", "primary", "master"], x: 55, y: 3, w: 41, h: 15 },
  { id: "great", label: "Great Room", aliases: ["great room", "living room", "family room"], x: 3, y: 10, w: 51, h: 14 },
  { id: "nook", label: "Nook", aliases: ["nook", "dining", "dining room"], x: 3, y: 24, w: 38, h: 12 },
  { id: "kitchen", label: "Kitchen", aliases: ["kitchen"], x: 41, y: 24, w: 23, h: 15 },
  { id: "foyer", label: "Foyer", aliases: ["foyer", "entry", "entryway"], x: 3, y: 36, w: 34, h: 10 },
  { id: "study", label: "Open Study", aliases: ["open study", "study", "office"], x: 20, y: 43, w: 30, h: 13 },
  { id: "bed2", label: "Bedroom 2", aliases: ["bedroom 2", "bedroom2", "bed 2"], x: 67, y: 35, w: 29, h: 13 },
  { id: "laundry", label: "Laundry", aliases: ["laundry", "laundry room"], x: 67, y: 47, w: 28, h: 7 },
  { id: "bed3", label: "Bedroom 3", aliases: ["bedroom 3", "bedroom3", "bed 3", "parker's room", "parker room"], x: 16, y: 57, w: 28, h: 13 },
  { id: "garage", label: "Garage", aliases: ["garage", "2-car garage", "2 car garage"], x: 44, y: 57, w: 52, h: 22 },
];

function friendly(s) {
  return s.attributes?.friendly_name || s.entity_id;
}

function norm(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function zoneForName(name) {
  const n = norm(name);
  if (!n) return null;
  return ROOM_DEFS.find(room =>
    room.aliases.some(alias => {
      const a = norm(alias);
      return n === a || n.includes(a) || a.includes(n);
    })
  ) || null;
}

function stateById(entityId) {
  return states.find(s => s.entity_id === entityId);
}

function buildRoomModel() {
  rooms = new Map(ROOM_DEFS.map(def => [def.id, { ...def, areaNames: [], lights: [] }]));
  if (!registry) return;

  const areas = registry.areas || [];
  const areaById = new Map(areas.map(a => [a.area_id || a.id, a]));
  const deviceById = new Map((registry.devices || []).map(d => [d.id, d]));
  const regEntities = registry.entities?.entities || [];

  for (const ent of regEntities) {
    if (!ent.ei?.startsWith("light.")) continue;
    if (ent.hb) continue;

    let areaId = ent.ai || null;
    if (!areaId && ent.di) areaId = deviceById.get(ent.di)?.area_id || null;

    const area = areaId ? areaById.get(areaId) : null;
    let zone = area ? zoneForName(area.name) : null;

    if (!zone) {
      const live = stateById(ent.ei);
      zone = zoneForName(live ? friendly(live) : ent.en || ent.ei);
    }

    if (!zone) continue;
    const room = rooms.get(zone.id);
    if (area?.name && !room.areaNames.includes(area.name)) room.areaNames.push(area.name);
    if (!room.lights.includes(ent.ei)) room.lights.push(ent.ei);
  }
}

function roomStats(room) {
  const live = room.lights.map(stateById).filter(Boolean);
  return {
    total: live.length,
    on: live.filter(s => s.state === "on").length,
    unavailable: live.filter(s => s.state === "unavailable").length,
  };
}

function renderFloorplan() {
  const layer = $("roomLayer");
  layer.innerHTML = "";

  for (const def of ROOM_DEFS) {
    const room = rooms.get(def.id) || { ...def, lights: [] };
    const stats = roomStats(room);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "room-zone";
    if (stats.on > 0) button.classList.add("is-on");
    if (selectedRoomId === def.id) button.classList.add("is-selected");
    button.style.left = def.x + "%";
    button.style.top = def.y + "%";
    button.style.width = def.w + "%";
    button.style.height = def.h + "%";
    button.dataset.roomId = def.id;
    button.setAttribute("aria-label", `${def.label}: ${stats.on} of ${stats.total} lights on`);

    const badge = document.createElement("span");
    badge.className = "room-badge";
    badge.innerHTML = `<strong>${def.label}</strong><span>${stats.total ? `💡 ${stats.on}/${stats.total}` : "No mapped lights"}</span>`;
    button.appendChild(badge);
    button.addEventListener("click", () => selectRoom(def.id));
    layer.appendChild(button);
  }

  const totalLights = states.filter(s => s.entity_id.startsWith("light.")).length;
  const onLights = states.filter(s => s.entity_id.startsWith("light.") && s.state === "on").length;
  $("lightCount").textContent = onLights;
  $("lightTotal").textContent = totalLights;
  renderSelectedRoom();
}

async function selectRoom(roomId) {
  selectedRoomId = roomId;
  renderFloorplan();
  $("roomPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function toggleRoom(room) {
  const liveLights = room.lights.map(stateById).filter(s => s && s.state !== "unavailable");
  if (!liveLights.length) return;

  const anyOn = liveLights.some(s => s.state === "on");
  const service = anyOn ? "turn_off" : "turn_on";
  const response = await fetch(`service/light/${service}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entity_id: liveLights.map(s => s.entity_id) }),
  });
  if (!response.ok) throw new Error(`Service call failed: ${response.status}`);
  await loadStates(false);
}

async function toggleLight(entity) {
  const service = entity.state === "on" ? "turn_off" : "turn_on";
  const response = await fetch(`service/light/${service}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entity_id: entity.entity_id }),
  });
  if (!response.ok) throw new Error(`Service call failed: ${response.status}`);
  await loadStates(false);
}

function renderSelectedRoom() {
  const panel = $("roomPanel");
  if (!selectedRoomId) {
    panel.innerHTML = '<div class="room-empty">Tap a room to see its lights.</div>';
    return;
  }

  const room = rooms.get(selectedRoomId);
  const stats = roomStats(room);
  const areaNote = room.areaNames.length
    ? `HA area: ${room.areaNames.join(", ")}`
    : "Matched by room/light name";

  panel.innerHTML = `
    <div class="room-panel-head">
      <div>
        <div class="eyebrow">ROOM CONTROL</div>
        <h2>${room.label}</h2>
        <div class="room-note">${areaNote}</div>
      </div>
      <button id="roomToggle" class="primary-action" ${stats.total ? "" : "disabled"}>
        ${stats.on ? "Turn room off" : "Turn room on"}
      </button>
    </div>
    <div id="roomLights" class="room-lights"></div>
  `;

  const toggle = $("roomToggle");
  if (toggle) toggle.addEventListener("click", () => toggleRoom(room).catch(showError));

  const list = $("roomLights");
  if (!room.lights.length) {
    list.innerHTML = '<div class="room-empty">No Home Assistant light entities are mapped to this room yet.</div>';
    return;
  }

  for (const entityId of room.lights) {
    const entity = stateById(entityId);
    if (!entity) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `light-row ${entity.state === "on" ? "is-on" : ""}`;
    button.disabled = entity.state === "unavailable";
    button.innerHTML = `
      <span>
        <strong>${friendly(entity)}</strong>
        <small>${entity.entity_id}</small>
      </span>
      <span class="light-state">${entity.state}</span>
    `;
    button.addEventListener("click", () => toggleLight(entity).catch(showError));
    list.appendChild(button);
  }
}

function renderUnmappedAreas() {
  const holder = $("unmappedAreas");
  if (!registry) {
    holder.textContent = "";
    return;
  }
  const unmapped = (registry.areas || []).filter(area => !zoneForName(area.name));
  if (!unmapped.length) {
    holder.innerHTML = '<span class="ok-note">All HA areas match a floor-plan room.</span>';
    return;
  }
  holder.innerHTML = '<span class="muted-label">Unmapped HA areas:</span> ' +
    unmapped.map(a => `<span class="area-chip">${a.name}</span>`).join(" ");
}

function renderEntityBrowser() {
  const q = $("search").value.trim().toLowerCase();
  const filtered = states
    .filter(s => !q || s.entity_id.toLowerCase().includes(q) || friendly(s).toLowerCase().includes(q))
    .sort((a, b) => friendly(a).localeCompare(friendly(b)))
    .slice(0, 150);

  const holder = $("entities");
  holder.innerHTML = "";
  for (const entity of filtered) {
    const row = document.createElement("div");
    row.className = "entity-row";
    row.innerHTML = `
      <div>
        <div>${friendly(entity)}</div>
        <div class="entity-id">${entity.entity_id}</div>
      </div>
      <div class="entity-state">${entity.state}</div>
    `;
    holder.appendChild(row);
  }
}

function showError(err) {
  console.error(err);
  $("status").textContent = `Error: ${err.message}`;
}

async function loadRegistry() {
  const response = await fetch("api/registry");
  if (!response.ok) throw new Error(`Registry API returned ${response.status}`);
  registry = await response.json();
  buildRoomModel();
  renderUnmappedAreas();
}

async function loadStates(updateStatus = true) {
  if (updateStatus) $("status").textContent = "Refreshing…";
  const response = await fetch("api/states");
  if (!response.ok) throw new Error(`HA API returned ${response.status}`);
  states = await response.json();
  $("entityCount").textContent = states.length;
  buildRoomModel();
  renderFloorplan();
  renderEntityBrowser();
  if (updateStatus) $("status").textContent = `Connected • ${new Date().toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})}`;
}

async function init() {
  try {
    await loadStates();
    await loadRegistry();
    buildRoomModel();
    renderFloorplan();
    renderEntityBrowser();
  } catch (err) {
    showError(err);
  }
}

$("refresh").addEventListener("click", () => init());
$("search").addEventListener("input", renderEntityBrowser);

init();
setInterval(() => loadStates(false).catch(showError), 5000);
