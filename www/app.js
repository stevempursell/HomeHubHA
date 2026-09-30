let states = [];

const $ = (id) => document.getElementById(id);

function friendly(s) {
  return s.attributes?.friendly_name || s.entity_id;
}

async function loadStates() {
  $("status").textContent = "Refreshing…";
  const response = await fetch("api/states");
  if (!response.ok) throw new Error(`HA API returned ${response.status}`);
  states = await response.json();
  $("status").textContent = `Connected • ${new Date().toLocaleTimeString()}`;
  render();
}

async function toggle(entity) {
  const domain = entity.entity_id.split(".")[0];
  const service = entity.state === "on" ? "turn_off" : "turn_on";
  await fetch(`service/${domain}/${service}`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({entity_id: entity.entity_id})
  });
  setTimeout(loadStates, 250);
}

function render() {
  $("entityCount").textContent = states.length;
  $("lightCount").textContent = states.filter(s => s.entity_id.startsWith("light.") && s.state === "on").length;
  $("openCount").textContent = states.filter(s =>
    s.entity_id.startsWith("binary_sensor.") &&
    ["on","open"].includes(s.state)
  ).length;

  const controllable = states
    .filter(s => s.entity_id.startsWith("light.") || s.entity_id.startsWith("switch."))
    .sort((a,b) => friendly(a).localeCompare(friendly(b)));

  $("controls").innerHTML = "";
  for (const entity of controllable) {
    const div = document.createElement("div");
    div.className = `card ${entity.state === "on" ? "on" : ""}`;
    div.innerHTML = `
      <div class="card-name">${friendly(entity)}</div>
      <div>
        <div class="card-state">${entity.state}</div>
        <div class="entity-id">${entity.entity_id}</div>
      </div>`;
    div.onclick = () => toggle(entity);
    $("controls").appendChild(div);
  }

  renderEntityList();
}

function renderEntityList() {
  const q = $("search").value.trim().toLowerCase();
  const filtered = states
    .filter(s => !q || s.entity_id.toLowerCase().includes(q) || friendly(s).toLowerCase().includes(q))
    .sort((a,b) => friendly(a).localeCompare(friendly(b)))
    .slice(0, 250);

  $("entities").innerHTML = "";
  for (const entity of filtered) {
    const row = document.createElement("div");
    row.className = "entity-row";
    row.innerHTML = `
      <div>
        <div>${friendly(entity)}</div>
        <div class="entity-id">${entity.entity_id}</div>
      </div>
      <div class="entity-state">${entity.state}</div>`;
    $("entities").appendChild(row);
  }
}

$("refresh").onclick = loadStates;
$("search").oninput = renderEntityList;

loadStates().catch(err => {
  $("status").textContent = `Connection failed: ${err.message}`;
});

setInterval(() => loadStates().catch(() => {}), 5000);
