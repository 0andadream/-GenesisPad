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
