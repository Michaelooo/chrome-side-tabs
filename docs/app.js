// ===== Theme: read stored / system preference, toggle .light on <html> =====
(function () {
  var root = document.documentElement;
  var stored = localStorage.getItem("theme");
  var prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
  if (stored === "light" || (!stored && prefersLight)) root.classList.add("light");

  var btn = document.getElementById("themeToggle");
  if (btn) {
    btn.addEventListener("click", function () {
      var isLight = root.classList.toggle("light");
      localStorage.setItem("theme", isLight ? "light" : "dark");
    });
  }
})();

// ===== Scroll reveal =====
(function () {
  var els = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window)) {
    els.forEach(function (el) { el.classList.add("in-view"); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add("in-view"); io.unobserve(e.target); }
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
  els.forEach(function (el) { io.observe(el); });
})();

// ===== Copy buttons =====
(function () {
  document.querySelectorAll(".copy-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy") || "";
      navigator.clipboard.writeText(text).then(function () {
        var prev = btn.textContent;
        btn.textContent = "已复制";
        btn.classList.add("copied");
        setTimeout(function () { btn.textContent = prev; btn.classList.remove("copied"); }, 1600);
      });
    });
  });
})();

// ===== Placeholder mock (used when a screenshot is missing) =====
// Referenced inline via <img onerror="this.replaceWith(buildMock())">.
function buildMock() {
  var groups = [
    { label: "工作文档", color: "#3b82f6", rows: [["#3b82f6", 0.9, true], ["#3b82f6", 0.7], ["#3b82f6", 0.55]] },
    { label: "技术资料", color: "#a855f7", rows: [["#a855f7", 0.8], ["#a855f7", 0.6]] },
    { label: "社交媒体", color: "#22c55e", rows: [["#22c55e", 0.75], ["#22c55e", 0.5]] }
  ];
  var wrap = document.createElement("div");
  wrap.className = "mock";
  var rail = document.createElement("div");
  rail.className = "mock__rail";
  var list = document.createElement("div");
  list.className = "mock__list";

  groups.forEach(function (g) {
    var h = document.createElement("div");
    h.className = "mock__group";
    h.textContent = g.label;
    list.appendChild(h);
    g.rows.forEach(function (r) {
      var row = document.createElement("div");
      row.className = "mock__row" + (r[2] ? " mock__row--active" : "");
      var fav = document.createElement("span");
      fav.className = "mock__fav";
      fav.style.background = r[0];
      var bar = document.createElement("span");
      bar.className = "mock__bar";
      bar.style.flex = String(r[1]);
      var tag = document.createElement("span");
      tag.className = "mock__tag";
      tag.style.background = g.color;
      tag.style.opacity = "0.25";
      row.appendChild(fav);
      row.appendChild(bar);
      row.appendChild(tag);
      list.appendChild(row);
    });
  });

  wrap.appendChild(rail);
  wrap.appendChild(list);
  return wrap;
}
