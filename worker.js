// Cloudflare Worker: фоновое обновление статусов репозиториев строго раз в час по Cron (без ручного обновления)
// Логика классификации:
//   - "announced" (анонсированные): репозитория нет на GitHub (отсутствует в repos), size === 0 или 0 коммитов
//   - "abandoned" (заброшены): > 30 дней без коммитов и без слияний PR (или репозиторий в архиве)
//   - "active"    (обновляются): есть коммиты или слияния за последние 30 дней

const GITHUB_OWNER = "lqsaf";
const KV_STORE_KEY = "lqsaf_hub_store_v1";
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_HOUR_SECONDS = 3600;
const ABANDONED_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

let memoryFallbackStore = {
  updatedAt: null,
  owner: GITHUB_OWNER,
  repos: {},
};

function buildGhHeaders(env) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "lqsaf-hub-worker/2.0",
  };
  if (env && env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function ghFetch(url, headers) {
  const res = await fetch(url, { headers });
  if (res.status === 404 || res.status === 409) {
    return { status: res.status, data: null };
  }
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} on ${url}`);
  }
  return { status: res.status, data: await res.json() };
}

async function loadStore(env) {
  if (env && env.HUB_KV) {
    try {
      const data = await env.HUB_KV.get(KV_STORE_KEY, "json");
      if (data && data.repos && typeof data.repos === "object") {
        memoryFallbackStore = data;
        return data;
      }
    } catch (err) {
      console.warn("Ошибка чтения HUB_KV:", err);
    }
  }
  return memoryFallbackStore;
}

async function saveStore(env, store) {
  memoryFallbackStore = store;
  if (env && env.HUB_KV) {
    try {
      await env.HUB_KV.put(KV_STORE_KEY, JSON.stringify(store));
    } catch (err) {
      console.warn("Ошибка записи HUB_KV:", err);
    }
  }
}

// Ежечасная задача: индексирует все публичные репозитории владельца за один проход
async function runHourlySync(env) {
  const owner = (env && env.GITHUB_OWNER) || GITHUB_OWNER;
  const headers = buildGhHeaders(env);
  const now = Date.now();

  const { status, data: repoList } = await ghFetch(
    `https://api.github.com/users/${encodeURIComponent(owner)}/repos?per_page=100&sort=pushed`,
    headers
  );

  if (status !== 200 || !Array.isArray(repoList)) {
    throw new Error(`Failed to fetch repos for ${owner}`);
  }

  const repos = {};

  await Promise.all(
    repoList.map(async (meta) => {
      if (!meta || !meta.name) return;
      const key = meta.name.toLowerCase();

      if (meta.size === 0) {
        repos[key] = {
          status: "announced",
          lastActivityAt: null,
        };
        return;
      }

      const pushedAtMs = meta.pushed_at ? Date.parse(meta.pushed_at) : 0;

      const [commitsResp, pullsResp] = await Promise.all([
        ghFetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(meta.name)}/commits?per_page=1`,
          headers
        ),
        ghFetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(meta.name)}/pulls?state=closed&sort=updated&direction=desc&per_page=10`,
          headers
        ),
      ]);

      if (
        commitsResp.status === 409 ||
        commitsResp.status === 404 ||
        (Array.isArray(commitsResp.data) && commitsResp.data.length === 0)
      ) {
        repos[key] = {
          status: "announced",
          lastActivityAt: null,
        };
        return;
      }

      let latestCommitMs = 0;
      const commitObj = commitsResp.data?.[0]?.commit;
      if (commitObj) {
        const d = commitObj.committer?.date || commitObj.author?.date;
        if (d) latestCommitMs = Date.parse(d) || 0;
      }

      let latestMergeMs = 0;
      if (Array.isArray(pullsResp.data)) {
        for (const pr of pullsResp.data) {
          if (pr && pr.merged_at) {
            const m = Date.parse(pr.merged_at) || 0;
            if (m > latestMergeMs) latestMergeMs = m;
          }
        }
      }

      const lastActivityMs = Math.max(latestCommitMs, latestMergeMs, pushedAtMs);
      if (!lastActivityMs) {
        repos[key] = {
          status: "announced",
          lastActivityAt: null,
        };
        return;
      }

      const isAbandoned =
        Boolean(meta.archived) || now - lastActivityMs > ABANDONED_THRESHOLD_MS;

      repos[key] = {
        status: isAbandoned ? "abandoned" : "active",
        lastActivityAt: new Date(lastActivityMs).toISOString(),
        latestCommitAt: latestCommitMs ? new Date(latestCommitMs).toISOString() : null,
        latestMergeAt: latestMergeMs ? new Date(latestMergeMs).toISOString() : null,
      };
    })
  );

  const updatedStore = {
    updatedAt: now,
    owner,
    repos,
  };

  await saveStore(env, updatedStore);
  return updatedStore;
}

export default {
  // Только чтение готового снимка (без эндпоинтов ручного сброса/обновления)
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: CORS_HEADERS,
      });
    }

    let store = await loadStore(env);
    const now = Date.now();

    // Первичная инициализация при самом первом холодном старте или устаревании > 1 часа без KV
    if (!store.updatedAt) {
      try {
        store = await runHourlySync(env);
      } catch (err) {
        return new Response(JSON.stringify({ error: err?.message || "Sync error" }), {
          status: 502,
          headers: CORS_HEADERS,
        });
      }
    } else if (now - store.updatedAt >= ONE_HOUR_MS) {
      ctx.waitUntil(runHourlySync(env).catch((e) => console.warn("Hourly bg sync failed:", e)));
    }

    return new Response(JSON.stringify(store), {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": `public, max-age=${ONE_HOUR_SECONDS}`,
      },
    });
  },

  // Запуск строго по расписанию раз в час ("0 * * * *")
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runHourlySync(env));
  },
};
