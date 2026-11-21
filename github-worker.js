// Постоянный фоновый Web Worker с автоматическим обновлением строго раз в час (без ручного обновления)
// Правила классификации:
//   - "announced" (анонсированные): репозитория нет (404), size === 0 или 0 коммитов
//   - "abandoned" (заброшены): > 1 месяца (30 дней) без коммитов и без слияний PR (или repo.archived)
//   - "active"    (обновляются): есть коммиты/слияния за последний месяц (противоречат заброшенным)

const GH_API = "https://api.github.com";
const ONE_HOUR_MS = 60 * 60 * 1000;
const HEADERS = {
  Accept: "application/vnd.github+json",
};

let state = {
  projects: [],
  githubOwner: "lqsaf",
  workerUrl: "",
  abandonedDaysThreshold: 30,
  syncIntervalMs: ONE_HOUR_MS,
};

let initialDelayTimer = null;
let hourlyIntervalTimer = null;
let isSyncing = false;

function parseRepoSlug(repoStr, fallbackOwner, projectId) {
  const raw = (repoStr || `${fallbackOwner}/${projectId}`).trim().replace(/^\/+|\/+$/g, "");
  const parts = raw.split("/");
  if (parts.length >= 2) {
    return {
      owner: parts[0],
      repo: parts[1],
      repoLower: parts[1].toLowerCase(),
      full: `${parts[0]}/${parts[1]}`.toLowerCase(),
    };
  }
  return {
    owner: fallbackOwner,
    repo: parts[0],
    repoLower: parts[0].toLowerCase(),
    full: `${fallbackOwner}/${parts[0]}`.toLowerCase(),
  };
}

async function fetchJsonSafe(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (res.status === 404 || res.status === 409) {
    return { status: res.status, data: null };
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const data = await res.json();
  return { status: res.status, data };
}

// Чтение готового часового снимка из Cloudflare Worker (формат { updatedAt, repos })
async function classifyViaCloudflareWorker(workerUrl, projects, githubOwner) {
  const res = await fetch(workerUrl, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Cloudflare Worker HTTP ${res.status}`);
  }
  const payload = await res.json();
  const repoDict = payload?.repos || payload?.projects;
  if (!repoDict || typeof repoDict !== "object") {
    throw new Error("Invalid Worker payload");
  }

  const statuses = {};
  for (const proj of projects) {
    const slug = parseRepoSlug(proj.repo, githubOwner, proj.id);
    const entry = repoDict[slug.repoLower] || repoDict[proj.id];
    statuses[proj.id] = entry || {
      status: "announced",
      lastActivityAt: null,
      reason: "no_repo",
    };
  }

  return {
    source: "worker",
    fetchedAt: payload.updatedAt || Date.now(),
    statuses,
  };
}

// Прямая проверка через GitHub REST API
async function classifyDirectlyFromGitHub(projects, githubOwner, abandonedDaysThreshold) {
  const now = Date.now();
  const thresholdMs = (abandonedDaysThreshold || 30) * 24 * 60 * 60 * 1000;

  const parsed = projects.map((p) => ({
    project: p,
    slug: parseRepoSlug(p.repo, githubOwner, p.id),
  }));

  const owners = [...new Set(parsed.map((item) => item.slug.owner.toLowerCase()))];
  const repoMap = new Map();

  await Promise.all(
    owners.map(async (owner) => {
      const { status, data } = await fetchJsonSafe(
        `${GH_API}/users/${encodeURIComponent(owner)}/repos?per_page=100&sort=pushed`
      );
      if (status === 200 && Array.isArray(data)) {
        for (const r of data) {
          if (r && r.full_name) {
            repoMap.set(r.full_name.toLowerCase(), r);
          }
        }
      }
    })
  );

  const statuses = {};

  await Promise.all(
    parsed.map(async ({ project, slug }) => {
      const repoMeta = repoMap.get(slug.full);

      if (!repoMeta || repoMeta.size === 0) {
        statuses[project.id] = {
          status: "announced",
          lastActivityAt: null,
          reason: !repoMeta ? "no_repo" : "empty_repo",
        };
        return;
      }

      const pushedAtMs = repoMeta.pushed_at ? Date.parse(repoMeta.pushed_at) : 0;

      const [commitsResp, pullsResp] = await Promise.all([
        fetchJsonSafe(
          `${GH_API}/repos/${encodeURIComponent(slug.owner)}/${encodeURIComponent(slug.repo)}/commits?per_page=1`
        ),
        fetchJsonSafe(
          `${GH_API}/repos/${encodeURIComponent(slug.owner)}/${encodeURIComponent(slug.repo)}/pulls?state=closed&sort=updated&direction=desc&per_page=10`
        ),
      ]);

      if (
        commitsResp.status === 409 ||
        commitsResp.status === 404 ||
        (Array.isArray(commitsResp.data) && commitsResp.data.length === 0)
      ) {
        statuses[project.id] = {
          status: "announced",
          lastActivityAt: null,
          reason: "no_commits",
        };
        return;
      }

      let latestCommitMs = 0;
      if (Array.isArray(commitsResp.data) && commitsResp.data[0]?.commit) {
        const c = commitsResp.data[0].commit;
        const dateStr = c.committer?.date || c.author?.date;
        if (dateStr) latestCommitMs = Date.parse(dateStr) || 0;
      }

      let latestMergeMs = 0;
      if (Array.isArray(pullsResp.data)) {
        for (const pr of pullsResp.data) {
          if (pr && pr.merged_at) {
            const mMs = Date.parse(pr.merged_at) || 0;
            if (mMs > latestMergeMs) latestMergeMs = mMs;
          }
        }
      }

      const lastActivityMs = Math.max(latestCommitMs, latestMergeMs, pushedAtMs);
      if (!lastActivityMs) {
        statuses[project.id] = {
          status: "announced",
          lastActivityAt: null,
          reason: "no_activity",
        };
        return;
      }

      const isAbandoned =
        Boolean(repoMeta.archived) || now - lastActivityMs > thresholdMs;

      statuses[project.id] = {
        status: isAbandoned ? "abandoned" : "active",
        lastActivityAt: new Date(lastActivityMs).toISOString(),
        latestCommitAt: latestCommitMs ? new Date(latestCommitMs).toISOString() : null,
        latestMergeAt: latestMergeMs ? new Date(latestMergeMs).toISOString() : null,
      };
    })
  );

  return {
    source: "github",
    fetchedAt: now,
    statuses,
  };
}

async function performSyncTick() {
  if (isSyncing) return;
  isSyncing = true;

  try {
    const { projects, githubOwner, workerUrl, abandonedDaysThreshold } = state;

    if (workerUrl && workerUrl.trim() !== "") {
      try {
        const cfResult = await classifyViaCloudflareWorker(
          workerUrl.trim(),
          projects,
          githubOwner
        );
        self.postMessage({ ok: true, ...cfResult });
        return;
      } catch {
        // Если внешний Cloudflare Worker недоступен — прозрачно переходим к прямому опросу GitHub
      }
    }

    const ghResult = await classifyDirectlyFromGitHub(
      projects,
      githubOwner,
      abandonedDaysThreshold
    );
    self.postMessage({ ok: true, ...ghResult });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error?.message || "Hourly sync error",
    });
  } finally {
    isSyncing = false;
  }
}

function scheduleHourlyLoop(lastFetchedAt) {
  clearTimeout(initialDelayTimer);
  clearInterval(hourlyIntervalTimer);

  const intervalMs = state.syncIntervalMs || ONE_HOUR_MS;
  const elapsed = lastFetchedAt ? Date.now() - lastFetchedAt : Infinity;
  const remainingMs = elapsed >= intervalMs ? 0 : Math.max(0, intervalMs - elapsed);

  if (remainingMs === 0) {
    performSyncTick();
    hourlyIntervalTimer = setInterval(performSyncTick, intervalMs);
  } else {
    initialDelayTimer = setTimeout(() => {
      performSyncTick();
      hourlyIntervalTimer = setInterval(performSyncTick, intervalMs);
    }, remainingMs);
  }
}

// Единственная точка входа при старте страницы — далее воркер живёт автономно по часовому таймеру
self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type && msg.type !== "START") return;

  state = {
    projects: Array.isArray(msg.projects) ? msg.projects : [],
    githubOwner: msg.githubOwner || "lqsaf",
    workerUrl: msg.workerUrl || "",
    abandonedDaysThreshold: msg.abandonedDaysThreshold || 30,
    syncIntervalMs: msg.syncIntervalMs || ONE_HOUR_MS,
  };

  scheduleHourlyLoop(msg.lastFetchedAt || 0);
});
