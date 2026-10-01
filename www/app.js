let states = [];
let registry = null;
let rooms = new Map();
let selectedRoomId = null;
let manualMappings = { entity_rooms: {} };
let appOptions = {
  show_alarm_controls: true,
  show_room_manager: true,
  show_diagnostics: false,
  auto_map_areas: true,
  auto_map_names: true,
  show_unavailable_entities: false,
  alarm_entity: "",
  enable_source_updater: false,
};

const $ = (id) => document.getElementById(id);

const ROOM_DEFS = [
  { id: "patio", label: "Covered Patio", aliases: ["covered patio", "patio", "back patio"], x: 3, y: 1, w: 51, h: 9 },
  { id: "primary", label: "Primary Bedroom", aliases: ["master bedroom", "primary bedroom", "primary", "master"], x: 55, y: 3, w: 41, h: 15 },
  { id: "great", label: "Great Room", aliases: ["great room", "living room", "family room"], x: 3, y: 10, w: 51, h: 14 },
  { id: "nook", label: "Dining Room", aliases: ["nook", "dining", "dining room"], x: 3, y: 24, w: 38, h: 12 },
  { id: "kitchen", label: "Kitchen", aliases: ["kitchen"], x: 41, y: 24, w: 23, h: 15 },
  { id: "foyer", label: "Foyer", aliases: ["foyer", "entry", "entryway"], x: 3, y: 36, w: 34, h: 10 },
  { id: "study", label: "Open Study", aliases: ["open study", "study", "office"], x: 20, y: 43, w: 30, h: 13 },
  { id: "bed2", label: "Bennett's Room", aliases: ["bedroom 2", "bedroom2", "bed 2", "bennett", "bennetts room", "bennett room"], x: 67, y: 35, w: 29, h: 13 },
  { id: "laundry", label: "Laundry", aliases: ["laundry", "laundry room"], x: 67, y: 47, w: 28, h: 7 },
  { id: "bed3", label: "Parker's Room", aliases: ["bedroom 3", "bedroom3", "bed 3", "parker", "parkers room", "parker room"], x: 16, y: 57, w: 28, h: 13 },
  { id: "garage", label: "Garage", aliases: ["garage", "2-car garage", "2 car garage"], x: 44, y: 57, w: 52, h: 22 },
];

const LIGHT_RULES = {
  great: ["living room", "fan light", "ceiling fan light"],
  nook: ["dining", "dining room", "nook"],
  kitchen: ["kitchen", "big light", "big lights", "island", "cabinet", "cabinets"],
  bed2: ["bennett"],
  bed3: ["parker"],
};

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

function registryEntityById(entityId) {
  return registry?.entities?.entities?.find(ent => ent.ei === entityId) || null;
}

function autoRoomIdsForEntity(entityId) {
  if (!registry) return [];

  const ent = registryEntityById(entityId);
  const live = stateById(entityId);
  const displayName = norm(live ? friendly(live) : ent?.en || entityId);
  const matches = new Set();

  if (ent && appOptions.auto_map_areas) {
    const areaById = new Map((registry.areas || []).map(a => [a.area_id || a.id, a]));
    const deviceById = new Map((registry.devices || []).map(d => [d.id, d]));

    let areaId = ent.ai || null;
    if (!areaId && ent.di) areaId = deviceById.get(ent.di)?.area_id || null;
    const area = areaId ? areaById.get(areaId) : null;
    const areaZone = area ? zoneForName(area.name) : null;
    if (areaZone) matches.add(areaZone.id);
  }

  if (appOptions.auto_map_names) {
    for (const [roomId, patterns] of Object.entries(LIGHT_RULES)) {
      if (patterns.some(pattern => displayName.includes(norm(pattern)))) {
        matches.add(roomId);
      }
    }

    if (!matches.size) {
      const nameZone = zoneForName(displayName);
      if (nameZone) matches.add(nameZone.id);
    }
  }

  return [...matches];
}

function effectiveRoomIds(entityId) {
  const mapping = manualMappings.entity_rooms || {};
  if (Object.prototype.hasOwnProperty.call(mapping, entityId)) {
    return mapping[entityId];
  }
  return autoRoomIdsForEntity(entityId);
}

function buildRoomModel() {
  rooms = new Map(ROOM_DEFS.map(def => [def.id, { ...def, areaNames: [], lights: [] }]));
  if (!registry) return;

  const areaById = new Map((registry.areas || []).map(a => [a.area_id || a.id, a]));
  const deviceById = new Map((registry.devices || []).map(d => [d.id, d]));

  for (const entity of states) {
    if (!entity.entity_id.startsWith("light.")) continue;

    const ent = registryEntityById(entity.entity_id);
    let areaName = null;
    if (ent) {
      let areaId = ent.ai || null;
      if (!areaId && ent.di) areaId = deviceById.get(ent.di)?.area_id || null;
      areaName = areaId ? areaById.get(areaId)?.name || null : null;
    }

    for (const roomId of effectiveRoomIds(entity.entity_id)) {
      const room = rooms.get(roomId);
      if (!room) continue;
      if (areaName && !room.areaNames.includes(areaName)) room.areaNames.push(areaName);
      if (!room.lights.includes(entity.entity_id)) room.lights.push(entity.entity_id);
    }
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

  renderAlarmPanel();
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

function alarmEntity() {
  if (appOptions.alarm_entity) {
    const configured = states.find(entity => entity.entity_id === appOptions.alarm_entity);
    if (configured) return configured;
  }
  return states.find(entity => entity.entity_id.startsWith("alarm_control_panel.")) || null;
}

function prettyAlarmState(state) {
  const labels = {
    disarmed: "Off",
    armed_home: "Armed Home",
    armed_away: "Armed Away",
    armed_night: "Armed Night",
    armed_vacation: "Armed Vacation",
    arming: "Arming…",
    disarming: "Disarming…",
    pending: "Pending…",
    triggered: "TRIGGERED",
    unavailable: "Unavailable",
    unknown: "Unknown",
  };
  return labels[state] || state.replaceAll("_", " ");
}

function renderAlarmPanel() {
  const alarm = alarmEntity();
  const name = $("alarmName");
  const state = $("alarmState");
  const home = $("armHome");
  const off = $("armOff");
  if (!name || !state || !home || !off) return;

  if (!alarm) {
    name.textContent = "No alarm panel found";
    state.textContent = "Add an alarm_control_panel entity in Home Assistant";
    home.disabled = true;
    off.disabled = true;
    return;
  }

  name.textContent = friendly(alarm);
  state.textContent = prettyAlarmState(alarm.state);
  state.dataset.state = alarm.state;

  const busy = ["arming", "disarming", "pending"].includes(alarm.state);
  home.disabled = busy || alarm.state === "armed_home" || alarm.state === "unavailable";
  off.disabled = busy || alarm.state === "disarmed" || alarm.state === "unavailable";
}

async function callAlarm(service) {
  const alarm = alarmEntity();
  if (!alarm) throw new Error("No alarm panel found");

  const response = await fetch(`service/alarm_control_panel/${service}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entity_id: alarm.entity_id }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Alarm service failed: ${response.status}${detail ? " • " + detail : ""}`);
  }

  await loadStates(false);
}

function renderEntityBrowser() {
  const q = $("search").value.trim().toLowerCase();
  const filtered = states
    .filter(s => appOptions.show_unavailable_entities || s.state !== "unavailable")
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

function populateManagerRooms() {
  const select = $("managerRoom");
  if (!select) return;
  const current = select.value;
  select.innerHTML = ROOM_DEFS.map(room =>
    `<option value="${room.id}">${room.label}</option>`
  ).join("");
  if (current && ROOM_DEFS.some(room => room.id === current)) select.value = current;
}

function renderManager() {
  const holder = $("managerEntities");
  const roomSelect = $("managerRoom");
  if (!holder || !roomSelect) return;

  const roomId = roomSelect.value || ROOM_DEFS[0].id;
  const q = $("managerSearch").value.trim().toLowerCase();
  const domain = $("managerDomain").value;

  const filtered = states
    .filter(entity => !domain || entity.entity_id.startsWith(domain + "."))
    .filter(entity => !q || entity.entity_id.toLowerCase().includes(q) || friendly(entity).toLowerCase().includes(q))
    .sort((a, b) => friendly(a).localeCompare(friendly(b)))
    .slice(0, 300);

  holder.innerHTML = "";
  for (const entity of filtered) {
    const assigned = effectiveRoomIds(entity.entity_id).includes(roomId);
    const manual = Object.prototype.hasOwnProperty.call(manualMappings.entity_rooms || {}, entity.entity_id);

    const label = document.createElement("label");
    label.className = "manager-row";
    label.innerHTML = `
      <input type="checkbox" ${assigned ? "checked" : ""} />
      <span class="manager-entity">
        <strong>${friendly(entity)}</strong>
        <small>${entity.entity_id}</small>
      </span>
      <span class="mapping-source">${manual ? "manual" : "auto"}</span>
    `;

    const checkbox = label.querySelector("input");
    checkbox.addEventListener("change", () => {
      const currentRooms = new Set(effectiveRoomIds(entity.entity_id));
      if (checkbox.checked) currentRooms.add(roomId);
      else currentRooms.delete(roomId);
      manualMappings.entity_rooms[entity.entity_id] = [...currentRooms];
      renderManager();
      buildRoomModel();
      renderFloorplan();
    });

    holder.appendChild(label);
  }

  $("managerStatus").textContent = `${filtered.length} entities shown • changes are local until saved`;
}

async function loadOptions() {
  const response = await fetch("api/options");
  if (!response.ok) throw new Error(`Options API returned ${response.status}`);
  appOptions = { ...appOptions, ...(await response.json()) };
  applyOptions();
}

function applyOptions() {
  const alarmCard = $("alarmCard");
  const roomManager = $("roomManager");
  const diagnostics = $("diagnosticsPanel");
  const maintenance = $("maintenancePanel");
  if (alarmCard) alarmCard.hidden = !appOptions.show_alarm_controls;
  if (roomManager) roomManager.hidden = !appOptions.show_room_manager;
  if (diagnostics) diagnostics.hidden = !appOptions.show_diagnostics;
  if (maintenance) maintenance.hidden = !appOptions.enable_source_updater;
}

async function updateSource() {
  const button = $("sourceUpdate");
  const status = $("sourceUpdateStatus");
  if (!button || !status) return;
  button.disabled = true;
  status.textContent = "Updating local source…";
  try {
    const response = await fetch("api/source/update", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Update failed: ${response.status}`);
    status.textContent = `${result.message || "Source updated."}${result.commit ? " • " + result.commit : ""} Now open Settings → Apps → Home Hub and choose Update.`;
  } catch (err) {
    status.textContent = err.message;
    throw err;
  } finally {
    button.disabled = false;
  }
}

async function loadMappings() {
  const response = await fetch("api/mappings");
  if (!response.ok) throw new Error(`Mappings API returned ${response.status}`);
  manualMappings = await response.json();
  if (!manualMappings.entity_rooms) manualMappings.entity_rooms = {};
}

async function saveMappings() {
  const response = await fetch("api/mappings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manualMappings),
  });
  if (!response.ok) throw new Error(`Could not save mappings: ${response.status}`);
  $("managerStatus").textContent = "Assignments saved.";
  buildRoomModel();
  renderFloorplan();
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
  buildRoomModel();
  renderFloorplan();
  renderEntityBrowser();
  if (updateStatus) $("status").textContent = `Connected • ${new Date().toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})}`;
}

async function init() {
  try {
    await loadOptions();
    await loadStates();
    await loadRegistry();
    await loadMappings();
    populateManagerRooms();
    buildRoomModel();
    renderFloorplan();
    renderEntityBrowser();
    renderManager();
  } catch (err) {
    showError(err);
  }
}

$("refresh").addEventListener("click", () => init());
$("search").addEventListener("input", renderEntityBrowser);
$("managerRoom").addEventListener("change", renderManager);
$("managerSearch").addEventListener("input", renderManager);
$("managerDomain").addEventListener("change", renderManager);
$("saveMappings").addEventListener("click", () => saveMappings().catch(showError));
$("armHome").addEventListener("click", () => callAlarm("alarm_arm_home").catch(showError));
$("armOff").addEventListener("click", () => callAlarm("alarm_disarm").catch(showError));
$("sourceUpdate")?.addEventListener("click", () => updateSource().catch(showError));

init();
setInterval(() => loadStates(false).catch(showError), 5000);
