// ASCII-движок волновых функций с интерференцией и рождением новых волн при соприкосновении
// Отрисовка на <canvas> моноширинными глифами для стабильных 60 FPS и плавного радужного спектра.

const GLYPHS = [" ", "·", "∙", ":", "~", "≈", "+", "*", "◦", "#", "@"];
const SPARK_GLYPHS = ["·", "+", "*", "✦"];

function circularMeanHue(h1, h2) {
  const r1 = (h1 * Math.PI) / 180;
  const r2 = (h2 * Math.PI) / 180;
  const x = Math.cos(r1) + Math.cos(r2);
  const y = Math.sin(r1) + Math.sin(r2);
  let deg = (Math.atan2(y, x) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

export function initAsciiWaveField(canvasId = "wave-canvas") {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return { setEnabled() {}, spawnAt() {} };

  const ctx = canvas.getContext("2d", { alpha: true });
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let enabled = true;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let cellW = 12;
  let cellH = 20;
  let cols = 0;
  let rows = 0;

  // Типизированные буферы сетки терминала (переиспользуются каждый кадр без аллокаций)
  let fieldSum = new Float32Array(0);
  let fieldEnergy = new Float32Array(0);
  let hueCos = new Float32Array(0);
  let hueSin = new Float32Array(0);
  let hitCount = new Uint8Array(0);

  let nextWaveId = 1;
  const waves = [];
  const sparks = [];
  const collidedPairs = new Set();

  let lastFrameMs = performance.now();
  let lastCollisionSpawnMs = 0;
  let lastAmbientSpawnMs = 0;
  let hueCursor = Math.random() * 360;

  const MAX_WAVES = 13;
  const MIN_WAVES = 3;
  const COLLISION_COOLDOWN_MS = 380;

  // Предкэшированная палитра радужных цветов (72 оттенка × 10 уровней прозрачности)
  const HUE_BUCKETS = 72;
  const ALPHA_BUCKETS = 10;
  const styleTable = new Array(HUE_BUCKETS * ALPHA_BUCKETS);
  for (let h = 0; h < HUE_BUCKETS; h++) {
    const deg = h * (360 / HUE_BUCKETS);
    for (let a = 0; a < ALPHA_BUCKETS; a++) {
      const alpha = 0.14 + (a / (ALPHA_BUCKETS - 1)) * 0.78;
      const lightness = 58 + (a / (ALPHA_BUCKETS - 1)) * 18;
      styleTable[h * ALPHA_BUCKETS + a] = `hsla(${deg.toFixed(0)}, 95%, ${lightness.toFixed(0)}%, ${alpha.toFixed(3)})`;
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;

    const isCompact = width < 640;
    cellW = isCompact ? 10 : 12;
    cellH = isCompact ? 17 : 20;

    cols = Math.max(16, Math.ceil(width / cellW));
    rows = Math.max(16, Math.ceil(height / cellH));

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `500 ${isCompact ? 12 : 14}px "JetBrains Mono", "Fira Code", "SFMono-Regular", Consolas, monospace`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";

    const total = cols * rows;
    fieldSum = new Float32Array(total);
    fieldEnergy = new Float32Array(total);
    hueCos = new Float32Array(total);
    hueSin = new Float32Array(total);
    hitCount = new Uint8Array(total);
  }

  function spawnWave({
    x = width * (0.14 + Math.random() * 0.72),
    y = height * (0.14 + Math.random() * 0.72),
    hue = null,
    generation = 0,
    initialRadius = 4,
    energy = 1.0,
  } = {}) {
    if (waves.length >= MAX_WAVES) return null;

    if (hue === null) {
      hueCursor = (hueCursor + 83 + Math.random() * 38) % 360;
      hue = hueCursor;
    }

    const driftAngle = Math.random() * Math.PI * 2;
    const driftSpeed = 6 + Math.random() * 14;
    const maxDim = Math.hypot(width, height);

    const wave = {
      id: nextWaveId++,
      x,
      y,
      vx: Math.cos(driftAngle) * driftSpeed,
      vy: Math.sin(driftAngle) * driftSpeed,
      radius: initialRadius,
      speed: (generation > 0 ? 92 : 82) + Math.random() * 36,
      wavelength: (generation > 0 ? 34 : 42) + Math.random() * 14,
      sigma: (generation > 0 ? 34 : 44) + Math.random() * 14,
      phase: Math.random() * Math.PI * 2,
      omega: 4.2 + Math.random() * 2.4,
      hue: ((hue % 360) + 360) % 360,
      energy,
      age: 0,
      maxAge: Math.min(8.2, Math.max(5.0, (maxDim * 0.58) / 95)) * (generation > 0 ? 0.86 : 1),
      generation,
    };

    waves.push(wave);
    return wave;
  }

  function spawnCollisionSpark(x, y, hue) {
    sparks.push({
      x,
      y,
      hue,
      age: 0,
      maxAge: 0.68,
    });
  }

  function getWaveLifeFactor(w) {
    const p = w.age / w.maxAge;
    if (p >= 1) return 0;
    const fadeIn = Math.min(1, w.age / 0.35);
    const fadeOut = Math.pow(1 - p, 1.35);
    return fadeIn * fadeOut * w.energy;
  }

  // Аналитическое определение точки соприкосновения двух расширяющихся волновых фронтов
  function detectWaveCollisions(nowMs) {
    const n = waves.length;
    for (let i = 0; i < n; i++) {
      const a = waves[i];
      const lifeA = getWaveLifeFactor(a);
      if (lifeA < 0.26 || a.radius < 18) continue;

      for (let j = i + 1; j < n; j++) {
        const b = waves[j];
        const lifeB = getWaveLifeFactor(b);
        if (lifeB < 0.26 || b.radius < 18) continue;

        const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
        if (collidedPairs.has(key)) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);

        // Игнорируем волны с почти совпадающими центрами
        if (d < 64) {
          collidedPairs.add(key);
          continue;
        }

        const sumR = a.radius + b.radius;
        const diffR = Math.abs(a.radius - b.radius);

        // Соприкосновение внешних гребней или пересечение колец
        const outerTouch = Math.abs(sumR - d) <= 24;
        const ringIntersect = d < sumR && d > diffR;

        if (!outerTouch && !ringIntersect) continue;

        collidedPairs.add(key);

        if (
          waves.length >= MAX_WAVES ||
          nowMs - lastCollisionSpawnMs < COLLISION_COOLDOWN_MS
        ) {
          continue;
        }

        // Вычисляем точную геометрическую точку пересечения двух окружностей
        let hitX, hitY;
        if (d >= sumR - 4 || d <= diffR + 4) {
          const t = a.radius / Math.max(1, sumR);
          hitX = a.x + dx * t;
          hitY = a.y + dy * t;
        } else {
          const aDist = (a.radius * a.radius - b.radius * b.radius + d * d) / (2 * d);
          const hSq = Math.max(0, a.radius * a.radius - aDist * aDist);
          const h = Math.sqrt(hSq);
          const mx = a.x + (aDist * dx) / d;
          const my = a.y + (aDist * dy) / d;
          const rx = (-dy * h) / d;
          const ry = (dx * h) / d;

          // Выбираем ту из двух точек пересечения, которая ближе к центру экрана
          const p1x = mx + rx;
          const p1y = my + ry;
          const p2x = mx - rx;
          const p2y = my - ry;
          const c1 = Math.hypot(p1x - width * 0.5, p1y - height * 0.5);
          const c2 = Math.hypot(p2x - width * 0.5, p2y - height * 0.5);
          hitX = c1 <= c2 ? p1x : p2x;
          hitY = c1 <= c2 ? p1y : p2y;
        }

        // Проверяем, что точка соприкосновения находится внутри видимой области
        const margin = 24;
        if (
          hitX < margin ||
          hitX > width - margin ||
          hitY < margin ||
          hitY > height - margin
        ) {
          continue;
        }

        // Смешиваем оттенки родителей со сдвигом по радужному спектру
        const childHue = (circularMeanHue(a.hue, b.hue) + 64) % 360;
        const childGen = Math.min(5, Math.max(a.generation, b.generation) + 1);

        spawnWave({
          x: hitX,
          y: hitY,
          hue: childHue,
          generation: childGen,
          initialRadius: 6,
          energy: 0.94,
        });
        spawnCollisionSpark(hitX, hitY, childHue);
        lastCollisionSpawnMs = nowMs;
      }
    }

    // Периодическая очистка старых ключей в Set
    if (collidedPairs.size > 400) {
      const activeIds = new Set(waves.map((w) => String(w.id)));
      for (const pair of collidedPairs) {
        const [id1, id2] = pair.split(":");
        if (!activeIds.has(id1) || !activeIds.has(id2)) {
          collidedPairs.delete(pair);
        }
      }
    }
  }

  function seedInitialWaves() {
    waves.length = 0;
    collidedPairs.clear();
    const cx = width * 0.5;
    const cy = height * 0.5;
    const spreadX = Math.min(width * 0.28, 240);
    const spreadY = Math.min(height * 0.24, 180);

    spawnWave({ x: cx - spreadX, y: cy - spreadY * 0.5, hue: 190, initialRadius: 28 });
    spawnWave({ x: cx + spreadX, y: cy - spreadY * 0.2, hue: 315, initialRadius: 22 });
    spawnWave({ x: cx - spreadX * 0.15, y: cy + spreadY, hue: 55, initialRadius: 18 });
  }

  function step(dt, nowMs) {
    for (let i = waves.length - 1; i >= 0; i--) {
      const w = waves[i];
      w.age += dt;
      if (w.age >= w.maxAge) {
        waves.splice(i, 1);
        continue;
      }
      w.x += w.vx * dt;
      w.y += w.vy * dt;
      w.radius += w.speed * dt;
      w.phase += w.omega * dt;
    }

    for (let i = sparks.length - 1; i >= 0; i--) {
      sparks[i].age += dt;
      if (sparks[i].age >= sparks[i].maxAge) {
        sparks.splice(i, 1);
      }
    }

    detectWaveCollisions(nowMs);

    // Поддерживаем живой баланс волн на экране
    if (
      waves.length < MIN_WAVES ||
      (waves.length < 5 && nowMs - lastAmbientSpawnMs > 2100)
    ) {
      spawnWave();
      lastAmbientSpawnMs = nowMs;
    }
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    if (!enabled) return;

    fieldSum.fill(0);
    fieldEnergy.fill(0);
    hueCos.fill(0);
    hueSin.fill(0);
    hitCount.fill(0);

    // Аккумулируем суперпозицию волновых функций только в активных кольцах каждой волны
    for (let i = 0; i < waves.length; i++) {
      const w = waves[i];
      const life = getWaveLifeFactor(w);
      if (life <= 0.02) continue;

      const band = w.sigma * 2.55;
      const outerR = w.radius + band;
      const innerR = Math.max(0, w.radius - band);
      const outerRSq = outerR * outerR;
      const innerRSq = innerR * innerR;
      const invTwoSigmaSq = 1 / (2 * w.sigma * w.sigma);
      const k = (Math.PI * 2) / w.wavelength;

      const cMin = Math.max(0, Math.floor((w.x - outerR) / cellW));
      const cMax = Math.min(cols - 1, Math.ceil((w.x + outerR) / cellW));
      const rMin = Math.max(0, Math.floor((w.y - outerR) / cellH));
      const rMax = Math.min(rows - 1, Math.ceil((w.y + outerR) / cellH));

      for (let r = rMin; r <= rMax; r++) {
        const py = r * cellH + cellH * 0.5;
        const dy = py - w.y;
        const dySq = dy * dy;
        const rowOffset = r * cols;

        for (let c = cMin; c <= cMax; c++) {
          const px = c * cellW + cellW * 0.5;
          const dx = px - w.x;
          const dSq = dx * dx + dySq;

          if (dSq > outerRSq || dSq < innerRSq) continue;

          const dist = Math.sqrt(dSq);
          const delta = dist - w.radius;
          const envelope = life * Math.exp(-delta * delta * invTwoSigmaSq);
          if (envelope < 0.035) continue;

          const osc = Math.cos(k * delta - w.phase);
          const psi = envelope * osc;
          const energy = Math.abs(psi) * 0.85 + envelope * 0.22;

          const idx = rowOffset + c;
          fieldSum[idx] += psi;
          fieldEnergy[idx] += energy;

          // Выразительная радужная дисперсия вдоль фазы волны
          const localHueRad = ((w.hue + delta * 0.85) * Math.PI) / 180;
          hueCos[idx] += Math.cos(localHueRad) * energy;
          hueSin[idx] += Math.sin(localHueRad) * energy;
          if (envelope > 0.12 && hitCount[idx] < 255) {
            hitCount[idx] += 1;
          }
        }
      }
    }

    // Отрисовка ненулевых ячеек сетки
    let currentStyle = "";
    const total = cols * rows;

    for (let idx = 0; idx < total; idx++) {
      const e = fieldEnergy[idx];
      if (e < 0.075) continue;

      const overlaps = hitCount[idx];
      // Конструктивная интерференция при наложении двух и более волн
      const interferenceBoost = overlaps >= 2 ? 1.28 : 1.0;
      const intensity = Math.min(1, (Math.abs(fieldSum[idx]) * 0.78 + e * 0.34) * interferenceBoost);

      const glyphIdx = Math.min(
        GLYPHS.length - 1,
        Math.max(1, Math.floor(intensity * (GLYPHS.length - 0.01)))
      );

      let deg = (Math.atan2(hueSin[idx], hueCos[idx]) * 180) / Math.PI;
      if (deg < 0) deg += 360;

      const hBucket = Math.floor((deg / 360) * HUE_BUCKETS) % HUE_BUCKETS;
      const alphaNorm = Math.min(1, intensity * (overlaps >= 2 ? 1.0 : 0.82));
      const aBucket = Math.min(
        ALPHA_BUCKETS - 1,
        Math.max(0, Math.floor(alphaNorm * ALPHA_BUCKETS))
      );

      const style = styleTable[hBucket * ALPHA_BUCKETS + aBucket];
      if (style !== currentStyle) {
        ctx.fillStyle = style;
        currentStyle = style;
      }

      const r = (idx / cols) | 0;
      const c = idx - r * cols;
      ctx.fillText(GLYPHS[glyphIdx], c * cellW + cellW * 0.5, r * cellH + cellH * 0.5);
    }

    // Отрисовка вспышек рождения новой волны в точках соприкосновения
    for (let i = 0; i < sparks.length; i++) {
      const s = sparks[i];
      const p = s.age / s.maxAge;
      const alpha = (1 - p) * 0.92;
      const cCenter = Math.round((s.x - cellW * 0.5) / cellW);
      const rCenter = Math.round((s.y - cellH * 0.5) / cellH);

      ctx.fillStyle = `hsla(${s.hue.toFixed(0)}, 100%, 76%, ${alpha.toFixed(3)})`;
      currentStyle = "";

      const cxPx = cCenter * cellW + cellW * 0.5;
      const cyPx = rCenter * cellH + cellH * 0.5;
      const mainGlyph = SPARK_GLYPHS[Math.min(SPARK_GLYPHS.length - 1, Math.floor((1 - p) * 4))];
      ctx.fillText(mainGlyph, cxPx, cyPx);

      const reach = p < 0.45 ? 1 : 2;
      const armAlpha = (1 - p) * 0.55;
      ctx.fillStyle = `hsla(${((s.hue + 35) % 360).toFixed(0)}, 95%, 70%, ${armAlpha.toFixed(3)})`;
      ctx.fillText("·", cxPx - reach * cellW, cyPx);
      ctx.fillText("·", cxPx + reach * cellW, cyPx);
      ctx.fillText("·", cxPx, cyPx - reach * cellH);
      ctx.fillText("·", cxPx, cyPx + reach * cellH);
    }
  }

  function loop(nowMs) {
    const rawDt = (nowMs - lastFrameMs) / 1000;
    lastFrameMs = nowMs;
    const dt = Math.min(0.06, Math.max(0.001, rawDt));

    if (enabled && !document.hidden) {
      const timeScale = prefersReducedMotion.matches ? 0.22 : 1.0;
      step(dt * timeScale, nowMs);
      draw();
    }

    requestAnimationFrame(loop);
  }

  resize();
  seedInitialWaves();
  draw();

  window.addEventListener("resize", () => {
    resize();
    draw();
  });

  // Клик по пустому фону запускает новую волновую функцию
  window.addEventListener("pointerdown", (e) => {
    if (!enabled) return;
    const interactive = e.target.closest("a, button, input, textarea, select, [role='button']");
    if (interactive) return;
    spawnWave({
      x: e.clientX,
      y: e.clientY,
      initialRadius: 4,
      energy: 1.0,
    });
    spawnCollisionSpark(e.clientX, e.clientY, hueCursor);
  });

  requestAnimationFrame(loop);

  return {
    setEnabled(val) {
      enabled = Boolean(val);
      if (!enabled) {
        ctx.clearRect(0, 0, width, height);
      } else {
        draw();
      }
    },
    isEnabled() {
      return enabled;
    },
    spawnAt(x, y) {
      spawnWave({ x, y, initialRadius: 4 });
    },
  };
}
