const TAU = Math.PI * 2;

export function spherePoint(longitude, latitude) {
  const lon = longitude * Math.PI / 180;
  const lat = latitude * Math.PI / 180;
  return [Math.cos(lat) * Math.sin(lon), -Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
}

export function projectPoint(point, rotation) {
  const [x, y, z] = point;
  const rx = x * Math.cos(rotation) + z * Math.sin(rotation);
  const rz = z * Math.cos(rotation) - x * Math.sin(rotation);
  const tilt = -.16;
  return [rx, y * Math.cos(tilt) - rz * Math.sin(tilt), y * Math.sin(tilt) + rz * Math.cos(tilt)];
}

export function arcPoint(from, to, progress) {
  const dot = Math.max(-1, Math.min(1, from.reduce((sum, value, i) => sum + value * to[i], 0)));
  const angle = Math.acos(dot);
  if (angle < .0001) return [...from];
  const a = Math.sin((1 - progress) * angle) / Math.sin(angle);
  const b = Math.sin(progress * angle) / Math.sin(angle);
  const height = 1 + Math.sin(progress * Math.PI) * .18;
  return from.map((value, i) => (value * a + to[i] * b) * height);
}

export async function initGlobe() {
  const hero = document.querySelector('.hero');
  if (!hero) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  try {
    const landUrl = new URL('./assets/globe-land.json', import.meta.url);
    landUrl.search = new URL(import.meta.url).search;
    const response = await fetch(landUrl, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return;
    const land = (await response.json()).map(([lon, lat]) => spherePoint(lon, lat));
    const canvas = document.createElement('canvas');
    canvas.className = 'globe-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    const context = canvas.getContext('2d');
    if (!context) return;
    hero.querySelector('.cosmos').append(canvas);
    hero.classList.add('globe-ready');
    if (!reduced.matches) hero.classList.add('globe-intro');
    const host = spherePoint(104, 31);
    const peers = [[139, 36], [78, 22], [151, -33], [18, 52], [-122, 38]].map(([lon, lat]) => spherePoint(lon, lat));
    const grid = [];
    for (let lat = -75; lat <= 75; lat += 15) {
      grid.push(Array.from({ length: 121 }, (_, i) => spherePoint(i * 3, lat)));
    }
    for (let lon = 0; lon < 180; lon += 20) {
      grid.push(Array.from({ length: 121 }, (_, i) => spherePoint(lon, i * 3 - 180)));
    }
    let width = 0;
    let height = 0;
    let visible = true;
    let frame = 0;
    let elapsed = 0;
    let previous;
    let lastPaint = 0;
    const draw = (time) => {
      frame = 0;
      if (!visible || document.hidden) { previous = undefined; return; }
      if (previous !== undefined) elapsed += time - previous;
      previous = time;
      if (time - lastPaint > 32 || reduced.matches) {
        lastPaint = time;
        const mobile = width < 760;
        const radius = Math.min(width * (mobile ? .47 : .255), height * (mobile ? .245 : .4));
        const intro = reduced.matches ? 1 : Math.min(1, Math.max(0, (elapsed - 1700) / 1100));
        const shift = 1 - (1 - intro) ** 3;
        const cx = width * (.5 + (mobile ? .04 : .245) * shift);
        const cy = height * (mobile ? .69 + .06 * shift : .52);
        const rotation = -1.65 + (reduced.matches ? 0 : elapsed * .000025);
        const p = (point) => {
          const [x, y, z] = projectPoint(point, rotation);
          return [cx + x * radius, cy + y * radius, z];
        };
        context.clearRect(0, 0, width, height);
        context.globalAlpha = reduced.matches ? 1 : Math.min(1, elapsed / 800);
        const glow = context.createRadialGradient(cx, cy, radius * .7, cx, cy, radius * 1.3);
        glow.addColorStop(0, '#68e6c500'); glow.addColorStop(.5, '#68e6c51c'); glow.addColorStop(1, '#68e6c500');
        context.fillStyle = glow;
        context.fillRect(cx - radius * 1.4, cy - radius * 1.4, radius * 2.8, radius * 2.8);
        const ocean = context.createRadialGradient(cx - radius * .4, cy - radius * .5, 0, cx, cy, radius);
        ocean.addColorStop(0, '#153d3b'); ocean.addColorStop(.65, '#0b222a'); ocean.addColorStop(1, '#09151c');
        context.beginPath(); context.arc(cx, cy, radius, 0, TAU); context.fillStyle = ocean; context.fill();
        context.lineWidth = .65;
        context.strokeStyle = '#68e6c51b';
        for (const line of grid) {
          context.beginPath();
          let connected = false;
          for (const point of line) {
            const [x, y, z] = p(point);
            if (z > 0) { if (connected) context.lineTo(x, y); else context.moveTo(x, y); connected = true; }
            else connected = false;
          }
          context.stroke();
        }
        for (const point of land) {
          const [x, y, z] = p(point);
          if (z < 0) continue;
          context.fillStyle = `rgba(118,235,205,${.25 + z * .65})`;
          context.beginPath(); context.arc(x, y, mobile ? 1 : 1.25, 0, TAU); context.fill();
        }
        peers.forEach((peer, index) => {
          const reveal = reduced.matches ? 1 : Math.max(0, Math.min(1, (elapsed - 700 - index * 150) / 650));
          if (!reveal) return;
          context.strokeStyle = '#79f4d6aa'; context.lineWidth = 1;
          context.beginPath();
          let connected = false;
          for (let i = 0; i <= 64 * reveal; i++) {
            const [x, y, z] = p(arcPoint(host, peer, i / 64));
            if (z > 0) { if (connected) context.lineTo(x, y); else context.moveTo(x, y); connected = true; }
            else connected = false;
          }
          context.stroke();
          const [x, y, z] = p(peer);
          if (z > 0) {
            context.fillStyle = '#b9ffeb'; context.beginPath(); context.arc(x, y, 2.8, 0, TAU); context.fill();
            context.strokeStyle = '#68e6c555'; context.beginPath(); context.arc(x, y, 7, 0, TAU); context.stroke();
          }
          if (!reduced.matches && reveal === 1) {
            const [sx, sy, sz] = p(arcPoint(host, peer, (elapsed / 2400 + index * .19) % 1));
            if (sz > 0) { context.fillStyle = '#e6fff8'; context.beginPath(); context.arc(sx, sy, 2.2, 0, TAU); context.fill(); }
          }
        });
        const [hx, hy, hz] = p(host);
        if (hz > 0) {
          context.fillStyle = '#d5fff2'; context.shadowColor = '#68e6c5'; context.shadowBlur = 18;
          context.beginPath(); context.arc(hx, hy, 4.5, 0, TAU); context.fill(); context.shadowBlur = 0;
          context.strokeStyle = '#91ffda99'; context.beginPath(); context.arc(hx, hy, 12, 0, TAU); context.stroke();
        }
        context.globalAlpha = 1;
      }
      if (!reduced.matches) frame = requestAnimationFrame(draw);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
    new ResizeObserver(() => {
      width = hero.clientWidth; height = hero.clientHeight;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = width * dpr; canvas.height = height * dpr;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      schedule();
    }).observe(hero);
    new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; schedule(); }).observe(hero);
    document.addEventListener('visibilitychange', schedule);
    reduced.addEventListener('change', () => { hero.classList.remove('globe-intro'); schedule(); });
  } catch {
    // The existing CSS planet and original copy remain available if loading fails.
  }
}
