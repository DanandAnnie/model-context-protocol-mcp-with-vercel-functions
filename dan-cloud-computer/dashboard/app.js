// Dan Cloud Computers - minimal internal dashboard.
// Talks to the FastAPI control API on the same origin. The shared API token
// is entered once and kept in localStorage (internal tool, single token).

const API = ""; // same origin
const $ = (id) => document.getElementById(id);

function token() {
  return localStorage.getItem("dcc_token") || "";
}

function headers() {
  return { "Content-Type": "application/json", "X-API-Token": token() };
}

function setMsg(text, isError) {
  const el = $("msg");
  el.textContent = text || "";
  el.className = "msg" + (isError ? " error" : "");
}

async function api(path, opts = {}) {
  const res = await fetch(API + path, { headers: headers(), ...opts });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) {}
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

async function refresh() {
  try {
    const data = await api("/computers");
    renderRows(data.computers || []);
    $("conn").textContent = "connected";
    $("conn").className = "pill ok";
    setMsg("");
  } catch (err) {
    $("conn").textContent = "disconnected";
    $("conn").className = "pill bad";
    setMsg("Could not load computers: " + err.message, true);
  }
}

function renderRows(computers) {
  const tbody = $("rows");
  if (!computers.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No computers yet.</td></tr>';
    return;
  }
  tbody.innerHTML = computers.map((c) => {
    const created = (c.created_at || "").replace("T", " ").slice(0, 19);
    const statusClass = c.status === "running" ? "ok" : (c.status === "stopped" ? "warn" : "bad");
    return `
      <tr>
        <td><strong>${c.name}</strong></td>
        <td><span class="pill ${statusClass}">${c.status}</span></td>
        <td>${c.host_port || "-"}</td>
        <td>${c.notes || ""}</td>
        <td>${created}</td>
        <td class="actions">
          <button data-act="open" data-name="${c.name}" data-url="${c.vnc_url || ""}">Open</button>
          <button data-act="stop" data-name="${c.name}">Stop</button>
          <button data-act="start" data-name="${c.name}">Start</button>
          <button data-act="destroy" data-name="${c.name}" class="danger">Destroy</button>
        </td>
      </tr>`;
  }).join("");
}

async function spawn() {
  const name = $("new-name").value.trim();
  const notes = $("new-notes").value.trim();
  if (!name) { setMsg("Enter a name first.", true); return; }
  setMsg("Spawning " + name + "...");
  try {
    await api("/computers", { method: "POST", body: JSON.stringify({ name, notes }) });
    $("new-name").value = "";
    $("new-notes").value = "";
    setMsg("Spawned " + name + ".");
    refresh();
  } catch (err) {
    setMsg("Spawn failed: " + err.message, true);
  }
}

async function handleAction(act, name, url) {
  try {
    if (act === "open") {
      if (url) window.open(url, "_blank");
      else setMsg("No VNC URL for " + name, true);
      return;
    }
    if (act === "destroy" && !confirm(`Destroy '${name}'? The container is removed.`)) return;
    if (act === "destroy") {
      await api("/computers/" + name, { method: "DELETE" });
    } else {
      await api(`/computers/${name}/${act}`, { method: "POST" });
    }
    setMsg(`${act} ${name} done.`);
    refresh();
  } catch (err) {
    setMsg(`${act} failed: ` + err.message, true);
  }
}

// ---- wire up ----
$("save-token").onclick = () => {
  localStorage.setItem("dcc_token", $("token").value.trim());
  setMsg("Token saved.");
  refresh();
};
$("spawn-btn").onclick = spawn;
$("refresh-btn").onclick = refresh;
$("rows").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  handleAction(btn.dataset.act, btn.dataset.name, btn.dataset.url);
});

// init
$("token").value = token();
refresh();
setInterval(refresh, 10000); // light auto-refresh
