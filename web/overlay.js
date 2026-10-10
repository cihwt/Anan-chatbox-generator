/* Shared SVG polygon-overlay renderer. No dependencies. */
(function (global) {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";

  function el(name) { return document.createElementNS(NS, name); }

  global.renderOverlay = function (svg, width, height, points, opts) {
    opts = opts || {};
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("preserveAspectRatio", "none");
    while (svg.firstChild) { svg.removeChild(svg.firstChild); }

    if (!points || points.length < 2) { return; }

    var poly = el("polygon");
    poly.setAttribute("points", points.map(function (p) {
      return p.x + "," + p.y;
    }).join(" "));
    poly.setAttribute("fill", "rgba(76,154,255,.18)");
    poly.setAttribute("stroke", "#4c9aff");
    poly.setAttribute("stroke-width", opts.strokeWidth || 1.5);
    poly.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(poly);

    if (!opts.handles) { return; }

    // keep the handles a constant on-screen size regardless of image resolution
    var shownW = svg.getBoundingClientRect().width;
    var scale = shownW ? shownW / width : 0;
    var r = opts.handleRadius || (scale ? 6 / scale : Math.max(2.5, width / 220));
    points.forEach(function (p, i) {
      var c = el("circle");
      c.setAttribute("cx", p.x);
      c.setAttribute("cy", p.y);
      c.setAttribute("r", r);
      c.setAttribute("fill", "#4c9aff");
      c.setAttribute("stroke", "#fff");
      c.setAttribute("stroke-width", 1);
      c.setAttribute("vector-effect", "non-scaling-stroke");
      c.setAttribute("data-index", i);
      svg.appendChild(c);
    });
  };
})(window);
