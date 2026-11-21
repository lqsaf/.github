import { CONFIG, PROJECTS, SOCIALS } from "./config.js";
import { initAsciiWaveField } from "./waves.js";

const CACHE_KEY = "lqsaf_hub_gh_cache_v1";
const WAVES_PREF_KEY = "lqsaf_hub_waves_v1";
const ONE_HOUR_MS = 60 * 60 * 1000;

const STATUS_BUCKETS = [
  {
    key: "active",
    title: "обновляются",
    emptyText: "нет активных обновлений за месяц",
  },
  {
    key: "announced",
    title: "анонсированные",
    emptyText: "нет анонсированных проектов",
  },
  {
    key: "abandoned",
    title: "заброшены",
    emptyText: "пока пусто",
  },
];

function hueForId(id, index = 0) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash + index * 67) % 360;
}

function buildFallbackSvgDataUri(label) {
  const short = (label || "?").slice(0, 4).toLowerCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><rect x="170" y="170" width="660" height="660" rx="140" fill="none" stroke="#ffffff" stroke-width="48"/><text x="500" y="555" text-anchor="middle" fill="#ffffff" font-family="monospace" font-weight="700" font-size="250">${short}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function resolveProjectDefaults(proj) {
  const id = proj.id.trim();
  const owner = CONFIG.githubOwner || "lqsaf";
  return {
    ...proj,
    id,
    name: proj.name || id,
    desc: proj.desc || "",
    url: proj.url || `https://${owner}.github.io/${id}/`,
    repo: proj.repo || `${owner}/${id}`,
    logo: proj.logo || `./logos/${id}logo.svg`,
    rootLogoFallback: `./${id}logo.svg`,
  };
}

function formatRelativeActivity(statusInfo) {
  if (!statusInfo) return "...";
  if (statusInfo.status === "announced") return "анонс";
  if (!statusInfo.lastActivityAt) return statusInfo.status === "abandoned" ? "> 1 мес" : "активен";

  const ts = Date.parse(statusInfo.lastActivityAt);
  if (!ts) return "";

  const diffMs = Math.max(0, Date.now() - ts);
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);

  if (hours < 1) return "только что";
  if (hours < 24) return "сегодня";
  if (days === 1) return "вчера";
  if (days < 30) return `${days}д назад`;
  const months = Math.floor(days / 30);
  return months <= 1 ? "1 мес назад" : `${months} мес назад`;
}

function createAppTile(item, index, activityText = "") {
  const a = document.createElement("a");
  a.className = "app-tile";
  a.href = item.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.style.setProperty("--tile-hue", String(hueForId(item.id, index)));
  a.style.animationDelay = `${Math.min(index * 35, 240)}ms`;
  a.title = item.desc ? `${item.name} — ${item.desc}` : item.name;

  const avatar = document.createElement("div");
  avatar.className = "app-avatar";

  const img = document.createElement("img");
  img.className = "app-logo";
  img.alt = `${item.name} logo`;
  img.decoding = "async";
  img.src = item.logo;

  let triedRootFallback = false;
  img.addEventListener("error", () => {
    if (!triedRootFallback && item.rootLogoFallback && img.src !== item.rootLogoFallback) {
      triedRootFallback = true;
      img.src = item.rootLogoFallback;
      return;
    }
    img.src = buildFallbackSvgDataUri(item.name);
  });

  avatar.appendChild(img);

  const caption = document.createElement("div");
  caption.className = "app-caption";

  const nameEl = document.createElement("span");
  nameEl.className = "app-name";
  nameEl.textContent = item.name;
  caption.appendChild(nameEl);

  if (item.desc) {
    const descEl = document.createElement("span");
    descEl.className = "app-desc";
    descEl.textContent = item.desc;
    caption.appendChild(descEl);
  }

  if (activityText) {
    const actEl = document.createElement("span");
    actEl.className = "app-activity";
    actEl.textContent = activityText;
    caption.appendChild(actEl);
  }

  a.appendChild(avatar);
  a.appendChild(caption);
  return a;
}

function renderProjects(normalizedProjects, statusMap) {
  const container = document.getElementById("projects-groups");
  const totalMeta = document.getElementById("projects-meta");
  if (!container) return;

  if (totalMeta) {
    totalMeta.textContent = `всего: ${normalizedProjects.length}`;
  }

  const grouped = {
    active: [],
    announced: [],
    abandoned: [],
  };

  for (const proj of normalizedProjects) {
    const info = statusMap?.[proj.id] || { status: "announced", lastActivityAt: null };
    const bucket = grouped[info.status] ? info.status : "announced";
    grouped[bucket].push({ proj, info });
  }

  grouped.active.sort((a, b) => {
    const ta = a.info.lastActivityAt ? Date.parse(a.info.lastActivityAt) : 0;
    const tb = b.info.lastActivityAt ? Date.parse(b.info.lastActivityAt) : 0;
    return tb - ta;
  });

  container.replaceChildren();

  for (const bucketDef of STATUS_BUCKETS) {
    const items = grouped[bucketDef.key];
    const section = document.createElement("div");
    section.className =
      items.length === 0 ? "status-group status-group--empty" : "status-group";
    section.dataset.status = bucketDef.key;

    const header = document.createElement("div");
    header.className = "status-header";

    const dot = document.createElement("span");
    dot.className = "status-indicator";
    dot.setAttribute("aria-hidden", "true");

    const title = document.createElement("span");
    title.textContent = bucketDef.title;

    const count = document.createElement("span");
    count.className = "status-count";
    count.textContent = `[${items.length}]`;

    const rule = document.createElement("span");
    rule.className = "status-rule";
    rule.setAttribute("aria-hidden", "true");

    header.append(dot, title, count, rule);

    if (items.length === 0) {
      const emptyNote = document.createElement("span");
      emptyNote.className = "status-empty-note";
      emptyNote.textContent = bucketDef.emptyText;
      header.appendChild(emptyNote);
      section.appendChild(header);
    } else {
      const grid = document.createElement("div");
      grid.className = "app-grid";
      items.forEach(({ proj, info }, idx) => {
        const actText = formatRelativeActivity(info);
        grid.appendChild(createAppTile(proj, idx, actText));
      });
      section.append(header, grid);
    }

    container.appendChild(section);
  }
}

function renderSocials() {
  const grid = document.getElementById("socials-grid");
  const meta = document.getElementById("socials-meta");
  if (!grid) return;

  if (meta) {
    meta.textContent = `@${CONFIG.githubOwner}`;
  }

  grid.replaceChildren();
  SOCIALS.forEach((soc, idx) => {
    grid.appendChild(createAppTile(soc, idx + 10));
  });
}

function initSupportButton() {
  const btn = document.getElementById("support-btn");
  const labelEl = document.getElementById("support-btn-label");
  const hint = document.getElementById("support-hint");
  if (!btn) return;

  if (labelEl && CONFIG.supportLabel) {
    labelEl.textContent = CONFIG.supportLabel;
  }

  let hideTimer = null;

  btn.addEventListener("click", () => {
    const url = (CONFIG.supportUrl || "").trim();
    if (url) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }

    if (hint) {
      hint.textContent = "// скоро: ссылка для поддержки пока не подключена";
      hint.classList.add("visible");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        hint.classList.remove("visible");
      }, 2600);
    }
  });
}

function readCachedStatuses() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.statuses) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedStatuses(payload) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Игнорируем блокировку storage
  }
}

// Фолбэк для сред, где запрещено создание Web Worker (также строго раз в час)
async function runMainThreadHourlyFallback(normalizedProjects, lastFetchedAt) {
  const intervalMs = CONFIG.syncIntervalMs || ONE_HOUR_MS;
  const owner = CONFIG.githubOwner || "lqsaf";
  const thresholdMs = (CONFIG.abandonedDaysThreshold || 30) * 24 * 60 * 60 * 1000;

  async function tick() {
    try {
      const res = await fetch(
        `https://api.github.com/users/${encodeURIComponent(owner)}/repos?per_page=100&sort=pushed`,
        { headers: { Accept: "application/vnd.github+json" } }
      );
      if (!res.ok) return;
      const repos = await res.json();
      const map = new Map(repos.map((r) => [r.full_name.toLowerCase(), r]));
      const now = Date.now();
      const statuses = {};

      for (const p of normalizedProjects) {
        const meta = map.get(p.repo.toLowerCase());
        if (!meta || meta.size === 0 || !meta.pushed_at) {
          statuses[p.id] = { status: "announced", lastActivityAt: null };
        } else {
          const pushedMs = Date.parse(meta.pushed_at);
          const isAbandoned = Boolean(meta.archived) || now - pushedMs > thresholdMs;
          statuses[p.id] = {
            status: isAbandoned ? "abandoned" : "active",
            lastActivityAt: meta.pushed_at,
          };
        }
      }

      writeCachedStatuses({ fetchedAt: now, source: "github", statuses });
      renderProjects(normalizedProjects, statuses);
    } catch {
      // Тихо ждём следующего часового тика
    }
  }

  const elapsed = lastFetchedAt ? Date.now() - lastFetchedAt : Infinity;
  const remainingMs = elapsed >= intervalMs ? 0 : Math.max(0, intervalMs - elapsed);

  setTimeout(() => {
    tick();
    setInterval(tick, intervalMs);
  }, remainingMs);
}

// Автономная фоновая синхронизация раз в час через Web Worker (без кнопок ручного обновления)
function initHourlyGitHubAutoSort(normalizedProjects) {
  const cached = readCachedStatuses();

  if (cached?.statuses) {
    renderProjects(normalizedProjects, cached.statuses);
  } else {
    renderProjects(normalizedProjects, {});
  }

  const lastFetchedAt = cached?.fetchedAt || 0;

  try {
    const worker = new Worker(new URL("./github-worker.js", import.meta.url));

    worker.addEventListener("message", (event) => {
      const res = event.data;
      if (!res || !res.ok || !res.statuses) return;

      writeCachedStatuses({
        fetchedAt: res.fetchedAt || Date.now(),
        source: res.source,
        statuses: res.statuses,
      });
      renderProjects(normalizedProjects, res.statuses);
    });

    worker.addEventListener("error", () => {
      worker.terminate();
      runMainThreadHourlyFallback(normalizedProjects, lastFetchedAt);
    });

    worker.postMessage({
      type: "START",
      projects: normalizedProjects,
      githubOwner: CONFIG.githubOwner,
      workerUrl: CONFIG.workerUrl,
      abandonedDaysThreshold: CONFIG.abandonedDaysThreshold,
      syncIntervalMs: CONFIG.syncIntervalMs || ONE_HOUR_MS,
      lastFetchedAt,
    });
  } catch {
    runMainThreadHourlyFallback(normalizedProjects, lastFetchedAt);
  }
}

function initWaveToggle(waveController) {
  const btn = document.getElementById("waves-toggle-btn");
  if (!btn) return;

  let isOn = true;
  try {
    const saved = localStorage.getItem(WAVES_PREF_KEY);
    if (saved === "off") isOn = false;
  } catch {}

  function apply() {
    waveController.setEnabled(isOn);
    btn.textContent = isOn ? "ascii::on" : "ascii::off";
  }

  btn.addEventListener("click", () => {
    isOn = !isOn;
    try {
      localStorage.setItem(WAVES_PREF_KEY, isOn ? "on" : "off");
    } catch {}
    apply();
  });

  apply();
}

document.addEventListener("DOMContentLoaded", () => {
  const waveController = initAsciiWaveField("wave-canvas");
  initWaveToggle(waveController);

  const normalizedProjects = PROJECTS.map(resolveProjectDefaults);
  renderSocials();
  initSupportButton();
  initHourlyGitHubAutoSort(normalizedProjects);
});
