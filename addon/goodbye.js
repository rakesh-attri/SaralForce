// Gentle rising petals (pure decoration, no dependencies).
(function () {
  var colors = ["#ffd9a0", "#ffab66", "#ff8a3d", "#ffe9c4"];
  function spawn() {
    var p = document.createElement("div");
    p.className = "petal";
    var size = 6 + Math.random() * 10;
    p.style.width = size + "px";
    p.style.height = size + "px";
    p.style.left = Math.random() * 100 + "vw";
    p.style.background = colors[Math.floor(Math.random() * colors.length)];
    p.style.animationDuration = (7 + Math.random() * 7) + "s";
    document.body.appendChild(p);
    setTimeout(function () { p.remove(); }, 15000);
  }
  for (var i = 0; i < 14; i++) setTimeout(spawn, i * 450);
  setInterval(spawn, 1600);
})();
