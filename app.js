const formatters = {
  volume: (value) => `$${Number(value).toLocaleString()}`,
  tvl: (value) => `$${Number(value).toLocaleString()}`,
  trades: (value) => Number(value).toLocaleString(),
  markets: (value) => Number(value).toLocaleString(),
  users: (value) => Number(value).toLocaleString(),
};

async function refreshStats() {
  try {
    const endpoint = window.GENESIS_STATS_ENDPOINT || "/stats.json";
    const response = await fetch(`${endpoint}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return;
    const stats = await response.json();
    Object.entries(formatters).forEach(([key, format]) => {
      const element = document.querySelector(`[data-stat="${key}"]`);
      if (element) element.textContent = format(stats[key] || 0);
    });
  } catch {
    // Statistics intentionally remain at zero until a data source is available.
  }
}

const menuButton = document.querySelector(".menu-button");
menuButton?.addEventListener("click", () => {
  const open = document.body.classList.toggle("menu-open");
  menuButton.setAttribute("aria-expanded", String(open));
});

document.querySelectorAll(".nav-pill a").forEach((link) => {
  link.addEventListener("click", () => {
    document.body.classList.remove("menu-open");
    menuButton?.setAttribute("aria-expanded", "false");
  });
});

refreshStats();
setInterval(refreshStats, 30000);

const motionStage = document.querySelector("[data-motion-stage]");
const motionWords = [...document.querySelectorAll("[data-motion-word]")];
let motionFrame;

function updateMotion() {
  motionFrame = undefined;
  if (!motionStage || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const rect = motionStage.getBoundingClientRect();
  const viewport = window.innerHeight;
  const progress = Math.max(0, Math.min(1, (viewport - rect.top) / (viewport + rect.height * 0.35)));
  motionStage.style.setProperty("--motion-progress", progress.toFixed(3));
  motionWords.forEach((word, index) => {
    const start = 0.1 + index * 0.18;
    const wordProgress = Math.max(0, Math.min(1, (progress - start) / 0.18));
    word.style.setProperty("--word-progress", wordProgress.toFixed(3));
  });
}

function requestMotionUpdate() {
  if (!motionFrame) motionFrame = requestAnimationFrame(updateMotion);
}

window.addEventListener("scroll", requestMotionUpdate, { passive: true });
window.addEventListener("resize", requestMotionUpdate);
updateMotion();

const sculptureShell = document.querySelector(".sculpture-shell");
if (sculptureShell && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  let sculptureFrame;
  let pointerX = 0;
  let pointerY = 0;
  function updateSculpture() {
    sculptureFrame = undefined;
    const maxScroll = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
    sculptureShell.style.setProperty("--rx", `${pointerY * -7}deg`);
    sculptureShell.style.setProperty("--ry", `${pointerX * 11}deg`);
    sculptureShell.style.setProperty("--scroll-turn", `${(window.scrollY / maxScroll) * 52}deg`);
  }
  function requestSculptureUpdate() {
    if (!sculptureFrame) sculptureFrame = requestAnimationFrame(updateSculpture);
  }
  window.addEventListener("pointermove", (event) => {
    pointerX = event.clientX / window.innerWidth - 0.5;
    pointerY = event.clientY / window.innerHeight - 0.5;
    requestSculptureUpdate();
  }, { passive: true });
  window.addEventListener("scroll", requestSculptureUpdate, { passive: true });
  window.addEventListener("resize", requestSculptureUpdate);
  updateSculpture();
}

const stepCards = [...document.querySelectorAll("[data-step]")];
const stepObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const index = stepCards.indexOf(entry.target);
      window.setTimeout(() => entry.target.style.setProperty("--step-progress", "1"), index * 140);
      stepObserver.unobserve(entry.target);
    });
  },
  { threshold: 0.28 }
);

stepCards.forEach((card) => {
  stepObserver.observe(card);
  card.addEventListener("pointermove", (event) => {
    const rect = card.getBoundingClientRect();
    card.style.setProperty("--mx", ((event.clientX - rect.left) / rect.width - 0.5).toFixed(2));
    card.style.setProperty("--my", ((event.clientY - rect.top) / rect.height - 0.5).toFixed(2));
  });
  card.addEventListener("pointerleave", () => {
    card.style.setProperty("--mx", "0");
    card.style.setProperty("--my", "0");
  });
});

const chart = document.querySelector("[data-market-chart]");
const livePrice = document.querySelector("[data-live-price]");
const liveSpread = document.querySelector("[data-live-spread]");

if (chart) {
  const context = chart.getContext("2d");
  let width = 0;
  let height = 0;
  let chartFrame;
  const chartMotionAllowed = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function sizeChart() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const rect = chart.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    chart.width = Math.round(width * ratio);
    chart.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function drawChart(time = 0) {
    context.clearRect(0, 0, width, height);
    const ink = "rgba(32,27,20,.72)";
    const muted = "rgba(32,27,20,.13)";
    const accent = "rgba(143,63,47,.82)";

    context.lineWidth = 1;
    context.strokeStyle = muted;
    for (let x = 0; x <= width; x += width / 12) {
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
    }
    for (let y = 0; y <= height; y += height / 6) {
      context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
    }

    const points = 120;
    const price = [];
    for (let index = 0; index < points; index += 1) {
      const x = (index / (points - 1)) * width;
      const wave = Math.sin(index * 0.17 + time * 0.00055) * 18;
      const micro = Math.sin(index * 0.49 - time * 0.0011) * 7;
      const drift = Math.sin(time * 0.0002) * 10;
      price.push([x, height * 0.47 + wave + micro + drift]);
    }

    const depth = context.createLinearGradient(0, height * 0.4, 0, height);
    depth.addColorStop(0, "rgba(143,63,47,.24)");
    depth.addColorStop(1, "rgba(143,63,47,0)");
    context.beginPath();
    price.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y));
    context.lineTo(width, height); context.lineTo(0, height); context.closePath();
    context.fillStyle = depth; context.fill();

    context.beginPath();
    price.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y));
    context.strokeStyle = accent; context.lineWidth = 1.6; context.stroke();

    const packet = ((time * 0.045) % width);
    const packetIndex = Math.min(points - 1, Math.round((packet / width) * (points - 1)));
    const packetY = price[packetIndex]?.[1] || height / 2;
    context.beginPath(); context.arc(packet, packetY, 4, 0, Math.PI * 2);
    context.fillStyle = accent; context.fill();
    context.beginPath(); context.arc(packet, packetY, 11, 0, Math.PI * 2);
    context.strokeStyle = "rgba(143,63,47,.28)"; context.stroke();

    context.beginPath();
    for (let index = 0; index < 42; index += 1) {
      const x = (index / 41) * width;
      const y = height * 0.78 - Math.abs(index - 21) * 2.2 + Math.sin(index + time * 0.001) * 5;
      index ? context.lineTo(x, y) : context.moveTo(x, y);
    }
    context.strokeStyle = ink; context.lineWidth = 1; context.setLineDash([4, 5]); context.stroke(); context.setLineDash([]);

    const numericPrice = 1.0024 + Math.sin(time * 0.0007) * 0.0031;
    if (livePrice) livePrice.textContent = numericPrice.toFixed(4);
    if (liveSpread) liveSpread.textContent = `${(0.018 + Math.abs(Math.sin(time * 0.0004)) * 0.014).toFixed(2)}%`;
    if (chartMotionAllowed) chartFrame = requestAnimationFrame(drawChart);
  }

  sizeChart();
  window.addEventListener("resize", sizeChart);
  if (chartMotionAllowed) chartFrame = requestAnimationFrame(drawChart);
  else drawChart(0);
}
