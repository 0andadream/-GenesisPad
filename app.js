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
