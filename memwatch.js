"use strict";

/* ==================================================================
   data — CSV parsing, grouping, and the stack model
   ================================================================== */

/* Palette: warm-to-cool spread that stays separable on the petrol
   ground. Ordered so the largest consumer takes the strongest teal. */
var PALETTE = [
  "#4fc3b0", "#e8a33d", "#7ea6f0", "#c98be0", "#e2757f", "#86c765",
  "#5fb8d8", "#dcc45e", "#a58cf0", "#e0894f", "#6fd3a0", "#d47ab3",
];

function num(v) {
  var n = Number(v);
  return isFinite(n) ? n : 0;
}

/** system.csv → one record per moment of whole-machine state. */
function parseSystem(text) {
  var out = [];
  d3.csvParse(text).forEach(function (r) {
    var epoch = num(r.epoch);
    if (!epoch) return;
    var memTotal = num(r.mem_total_kb);
    var memAvail = num(r.mem_avail_kb);
    var swapTotal = num(r.swap_total_kb);
    var swapFree = num(r.swap_free_kb);
    out.push({
      iso: r.iso || "",
      time: new Date(epoch * 1000),
      epoch: epoch,
      memTotal: memTotal,
      memAvail: memAvail,
      memFree: num(r.mem_free_kb),
      buffers: num(r.buffers_kb),
      cached: num(r.cached_kb),
      swapTotal: swapTotal,
      swapFree: swapFree,
      committed: num(r.committed_kb),
      cgroupCur: num(r.cgroup_cur_kb),
      cgroupMax: num(r.cgroup_max_kb),
      load1: num(r.load1),
      procsRunning: num(r.procs_running),
      low: r.low === "1",
      used: Math.max(0, memTotal - memAvail),
      swapUsed: Math.max(0, swapTotal - swapFree),
    });
  });
  out.sort(function (a, b) {
    return a.epoch - b.epoch;
  });
  return out;
}

/** procs.csv → one record per process observed at one moment. */
function parseProcs(text) {
  var out = [];
  d3.csvParse(text).forEach(function (r) {
    var epoch = num(r.epoch);
    if (!epoch) return;
    out.push({
      epoch: epoch,
      pid: num(r.pid),
      ppid: num(r.ppid),
      rss: num(r.rss_kb),
      vsz: num(r.vsz_kb),
      comm: r.comm || "?",
      cmdline: r.cmdline || "",
    });
  });
  return out;
}

/* Shorten a cmdline to the bit that identifies the work: the last
   path-ish argument, which for a compile is usually the source file. */
function describe(cmdline, comm) {
  if (!cmdline || cmdline === "[" + comm + "]") return "";
  var parts = cmdline.split(/\s+/);
  for (var i = parts.length - 1; i >= 0; i--) {
    if (/\.(c|C|cc|cpp|cxx|c\+\+|m|mm|ii|s|o|a|so)$/i.test(parts[i])) return parts[i];
  }
  return cmdline.length > 90 ? cmdline.slice(0, 90) + "…" : cmdline;
}

/**
 * Fold per-sample process rows into aligned series ready to stack.
 *
 * procs.csv only holds the top N processes per sample, so the logged
 * rows never account for all of `used`. The remainder becomes its own
 * band rather than being dropped — otherwise the stack quietly
 * under-reports exactly when the machine is busiest.
 */
function buildModel(samples, procs, groupBy, topN) {
  topN = topN || 11;
  var n = samples.length;
  var indexOf = new Map();
  samples.forEach(function (s, i) {
    indexOf.set(s.epoch, i);
  });

  var accs = new Map();
  procs.forEach(function (p) {
    var i = indexOf.get(p.epoch);
    if (i === undefined) return;
    var key = groupBy === "comm" ? p.comm : p.comm + "·" + p.pid;
    var a = accs.get(key);
    if (!a) {
      a = {
        key: key,
        label: groupBy === "comm" ? p.comm : p.comm + " " + p.pid,
        detail: describe(p.cmdline, p.comm),
        values: new Float64Array(n),
        counts: new Int32Array(n),
        peak: 0,
        peakIndex: 0,
        total: 0,
        seen: 0,
      };
      accs.set(key, a);
    }
    a.values[i] += p.rss;
    a.counts[i] += 1;
    a.total += p.rss;
    // keep the cmdline of the biggest instance seen, it's the useful one
    if (p.rss >= a.peak && p.cmdline) a.detail = describe(p.cmdline, p.comm);
    if (a.values[i] > a.peak) {
      a.peak = a.values[i];
      a.peakIndex = i;
    }
  });

  accs.forEach(function (a) {
    for (var i = 0; i < n; i++) if (a.values[i] > 0) a.seen++;
  });

  var ranked = Array.from(accs.values()).sort(function (x, y) {
    return y.peak - x.peak;
  });
  var shown = ranked.slice(0, topN);
  var rest = ranked.slice(topN);

  var series = shown.map(function (a, idx) {
    var maxC = 0;
    for (var i = 0; i < n; i++) if (a.counts[i] > maxC) maxC = a.counts[i];
    return {
      key: a.key,
      label: a.label,
      detail: a.detail,
      color: PALETTE[idx % PALETTE.length],
      values: a.values,
      peak: a.peak,
      peakIndex: a.peakIndex,
      mean: a.seen ? a.total / a.seen : 0,
      seen: a.seen,
      maxConcurrent: maxC,
      synthetic: false,
    };
  });

  if (rest.length) {
    var rv = new Float64Array(n);
    var rpeak = 0, rpeakIndex = 0, rtotal = 0, rseen = 0;
    rest.forEach(function (a) {
      for (var i = 0; i < n; i++) rv[i] += a.values[i];
    });
    for (var i = 0; i < n; i++) {
      if (rv[i] > 0) rseen++;
      rtotal += rv[i];
      if (rv[i] > rpeak) {
        rpeak = rv[i];
        rpeakIndex = i;
      }
    }
    series.push({
      key: "__rest__",
      label: rest.length + " smaller processes",
      detail: "everything below the top band, summed",
      color: "#5b6f7d",
      values: rv,
      peak: rpeak,
      peakIndex: rpeakIndex,
      mean: rseen ? rtotal / rseen : 0,
      seen: rseen,
      maxConcurrent: 0,
      synthetic: true,
    });
  }

  if (procs.length) {
    // whatever the sampler didn't log: kernel, page cache, small procs
    var uv = new Float64Array(n);
    var upeak = 0, upeakIndex = 0, utotal = 0;
    for (var j = 0; j < n; j++) {
      var logged = 0;
      for (var k = 0; k < series.length; k++) logged += series[k].values[j];
      uv[j] = Math.max(0, samples[j].used - logged);
      utotal += uv[j];
      if (uv[j] > upeak) {
        upeak = uv[j];
        upeakIndex = j;
      }
    }
    series.push({
      key: "__unsampled__",
      label: "not sampled",
      detail: "kernel, cache and processes under the size floor",
      color: "#33454f",
      values: uv,
      peak: upeak,
      peakIndex: upeakIndex,
      mean: n ? utotal / n : 0,
      seen: n,
      maxConcurrent: 0,
      synthetic: true,
    });
  } else {
    // no procs.csv: show total usage so the chart still reads
    var tv = new Float64Array(n);
    var tpeak = 0, tpeakIndex = 0;
    for (var q = 0; q < n; q++) {
      tv[q] = samples[q].used;
      if (tv[q] > tpeak) {
        tpeak = tv[q];
        tpeakIndex = q;
      }
    }
    series.push({
      key: "__used__",
      label: "in use",
      detail: "load procs.csv to break this down by process",
      color: "#4a6270",
      values: tv,
      peak: tpeak,
      peakIndex: tpeakIndex,
      mean: tpeak,
      seen: n,
      maxConcurrent: 0,
      synthetic: true,
    });
  }

  var memTotal = n ? samples[0].memTotal : 0;
  var cgroupMax = samples.reduce(function (m, s) {
    return Math.max(m, s.cgroupMax);
  }, 0);

  var worstIndex = 0;
  for (var w = 1; w < n; w++) {
    if (samples[w].memAvail < samples[worstIndex].memAvail) worstIndex = w;
  }

  var peakUsed = samples.reduce(function (m, s) {
    return Math.max(m, s.used);
  }, 0);

  return {
    samples: samples,
    series: series,
    memTotal: memTotal,
    cgroupMax: cgroupMax > 0 && cgroupMax < memTotal * 4 ? cgroupMax : 0,
    yMax: Math.max(memTotal, peakUsed) * 1.02 || 1,
    worstIndex: worstIndex,
    hasProcs: procs.length > 0,
    groupCount: accs.size,
    hiddenCount: rest.length,
  };
}

/** KB → a short human string. Instrument readouts want fixed width. */
function fmtKB(kb) {
  if (!kb) return "0";
  var mb = kb / 1024;
  if (mb < 1) return Math.round(kb) + " KB";
  if (mb < 1024) return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + " MB";
  return (mb / 1024).toFixed(2) + " GB";
}

function fmtClock(d) {
  function p(v) {
    return String(v).padStart(2, "0");
  }
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

/* ==================================================================
   chart — focus plot + brushable navigator strip
   ================================================================== */

var M = { top: 16, right: 74, bottom: 22, left: 56 };
var NM = { top: 12, right: 74, bottom: 16, left: 56 };

function gbLabel(kb) {
  return (kb / 1048576).toFixed(kb < 1048576 * 4 ? 1 : 0) + "G";
}

function Chart(plot, navEl, onScrub, onPick) {
  this.plot = plot;
  this.navEl = navEl;
  this.onScrub = onScrub;
  this.onPick = onPick;
  this.svg = d3.select(plot).append("svg");
  this.navSvg = d3.select(navEl).append("svg");
  this.model = null;
  this.rows = [];
  this.range = [0, 0];
  this.picked = null;
  this.cursor = null;
  this.xScale = null;
  this.yScale = null;
  this.stacked = [];

  var self = this;
  if (typeof ResizeObserver === "function") {
    var ro = new ResizeObserver(function () {
      self.draw();
    });
    ro.observe(plot);
    ro.observe(navEl);
  } else {
    window.addEventListener("resize", function () {
      self.drawNav();
      self.draw();
    });
  }
}

Chart.prototype.setModel = function (model) {
  var self = this;
  this.model = model;
  this.rows = model.samples.map(function (_, i) {
    var o = { i: i };
    model.series.forEach(function (s) {
      o[s.key] = s.values[i];
    });
    return o;
  });
  this.range = [0, Math.max(0, model.samples.length - 1)];
  this.cursor = model.worstIndex;
  this.drawNav();
  this.draw();
  void self;
};

Chart.prototype.setPicked = function (key) {
  var self = this;
  this.picked = key;
  this.svg.selectAll("path.layer").classed("is-muted", function (d) {
    return self.picked !== null && d.key !== self.picked;
  });
};

Chart.prototype.setCursor = function (i) {
  this.cursor = i;
  this.drawCursor();
};

Chart.prototype.focusOn = function (i) {
  if (!this.model) return;
  var n = this.model.samples.length;
  var span = Math.max(12, Math.round((this.range[1] - this.range[0]) / 2));
  this.range = [Math.max(0, i - span / 2), Math.min(n - 1, i + span / 2)];
  this.cursor = i;
  this.draw();
  this.onScrub(i);
};

Chart.prototype.draw = function () {
  var self = this;
  var m = this.model;
  if (!m || !m.samples.length) return;
  var W = this.plot.clientWidth;
  var H = this.plot.clientHeight;
  if (W < 60 || H < 60) return;

  var i0 = this.range[0];
  var i1 = this.range[1];
  var view = m.samples.slice(Math.floor(i0), Math.ceil(i1) + 1);
  if (!view.length) return;

  var x = d3
    .scaleTime()
    .domain([view[0].time, view[view.length - 1].time])
    .range([M.left, W - M.right]);
  var y = d3.scaleLinear().domain([0, m.yMax]).range([H - M.bottom, M.top]);

  this.svg.attr("viewBox", "0 0 " + W + " " + H);
  var root = this.svg.select("g.root");
  if (root.empty()) {
    root = this.svg.append("g").attr("class", "root");
    root.append("g").attr("class", "g-bands");
    root.append("g").attr("class", "g-grid");
    root.append("g").attr("class", "g-layers");
    root.append("g").attr("class", "g-limits");
    root.append("g").attr("class", "axis y-axis");
    root.append("g").attr("class", "axis x-axis");
    root.append("g").attr("class", "g-cursor");
    root.append("rect").attr("class", "capture").attr("fill", "transparent");
  }

  // amber wash over stretches the sampler flagged as low on memory
  var bands = [];
  for (var b = 0; b < m.samples.length; b++) {
    if (!m.samples[b].low) continue;
    var start = b;
    while (b + 1 < m.samples.length && m.samples[b + 1].low) b++;
    bands.push([start, b]);
  }
  root
    .select("g.g-bands")
    .selectAll("rect")
    .data(bands)
    .join("rect")
    .attr("class", "lowband")
    .attr("x", function (d) {
      return x(m.samples[d[0]].time);
    })
    .attr("width", function (d) {
      return Math.max(1.5, x(m.samples[d[1]].time) - x(m.samples[d[0]].time));
    })
    .attr("y", M.top)
    .attr("height", H - M.bottom - M.top);

  root
    .select("g.g-grid")
    .selectAll("line")
    .data(y.ticks(5))
    .join("line")
    .attr("class", "gridline")
    .attr("x1", M.left)
    .attr("x2", W - M.right)
    .attr("y1", y)
    .attr("y2", y);

  var stacked = d3
    .stack()
    .keys(
      m.series.map(function (s) {
        return s.key;
      })
    )
    .value(function (d, k) {
      return d[k] || 0;
    })(this.rows);

  var areaGen = d3
    .area()
    .x(function (_d, idx) {
      return x(m.samples[idx].time);
    })
    .y0(function (d) {
      return y(d[0]);
    })
    .y1(function (d) {
      return y(d[1]);
    });

  root
    .select("g.g-layers")
    .selectAll("path")
    .data(m.series, function (d) {
      return d.key;
    })
    .join("path")
    .attr("class", "layer")
    .attr("fill", function (d) {
      return d.color;
    })
    .attr("fill-opacity", function (d) {
      return d.synthetic ? 0.55 : 0.82;
    })
    .attr("stroke", function (d) {
      return d.color;
    })
    .attr("stroke-opacity", function (d) {
      return d.synthetic ? 0.3 : 0.55;
    })
    .attr("stroke-width", 0.6)
    .classed("is-muted", function (d) {
      return self.picked !== null && d.key !== self.picked;
    })
    .attr("d", function (_d, idx) {
      return areaGen(stacked[idx]);
    })
    .on("click", function (_e, d) {
      self.picked = self.picked === d.key ? null : d.key;
      self.setPicked(self.picked);
      self.onPick(self.picked);
    });

  // hard ceilings: what the kernel has, and what the cgroup will allow
  var limits = [];
  if (m.memTotal) limits.push({ v: m.memTotal, t: "MemTotal" });
  if (m.cgroupMax) limits.push({ v: m.cgroupMax, t: "cgroup max" });
  var lim = root
    .select("g.g-limits")
    .selectAll("g")
    .data(limits)
    .join(function (enter) {
      var g = enter.append("g");
      g.append("line").attr("class", "limit");
      g.append("text").attr("class", "limit-label");
      return g;
    });
  lim
    .select("line")
    .attr("x1", M.left)
    .attr("x2", W - M.right)
    .attr("y1", function (d) {
      return y(d.v);
    })
    .attr("y2", function (d) {
      return y(d.v);
    });
  lim
    .select("text")
    .attr("x", W - M.right + 6)
    .attr("y", function (d) {
      return y(d.v) + 3;
    })
    .text(function (d) {
      return d.t;
    });

  root
    .select("g.y-axis")
    .attr("transform", "translate(" + M.left + ",0)")
    .call(d3.axisLeft(y).ticks(5).tickFormat(gbLabel).tickSize(0));
  root
    .select("g.x-axis")
    .attr("transform", "translate(0," + (H - M.bottom) + ")")
    .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(W / 110))).tickSize(0));

  var times = view.map(function (s) {
    return s.time;
  });
  root
    .select("rect.capture")
    .attr("x", M.left)
    .attr("y", M.top)
    .attr("width", Math.max(0, W - M.left - M.right))
    .attr("height", Math.max(0, H - M.top - M.bottom))
    .on("pointermove", function (e) {
      var px = d3.pointer(e)[0];
      var abs = Math.floor(i0) + d3.bisectCenter(times, x.invert(px));
      self.cursor = abs;
      self.drawCursor();
      self.onScrub(abs);
    })
    .on("pointerleave", function () {
      self.cursor = m.worstIndex;
      self.drawCursor();
      self.onScrub(null);
    });

  this.xScale = x;
  this.yScale = y;
  this.stacked = stacked;
  this.drawCursor();
};

Chart.prototype.drawCursor = function () {
  var self = this;
  var m = this.model;
  var x = this.xScale;
  var y = this.yScale;
  if (!m || !x || !y) return;
  var g = this.svg.select("g.g-cursor");
  var H = this.plot.clientHeight;
  var i = this.cursor;

  var showWorst = m.worstIndex >= 0 && m.samples.length > 0;
  var worstX = showWorst ? x(m.samples[m.worstIndex].time) : 0;

  var worst = g.select("g.worst");
  if (worst.empty()) {
    worst = g.append("g").attr("class", "worst");
    worst.append("line").attr("class", "worstline");
    worst.append("text").attr("class", "worst-tag").text("tightest");
  }
  worst
    .attr("display", showWorst && i !== m.worstIndex ? null : "none")
    .select("line")
    .attr("x1", worstX)
    .attr("x2", worstX)
    .attr("y1", M.top)
    .attr("y2", H - M.bottom);
  worst
    .select("text")
    .attr("x", worstX + 4)
    .attr("y", M.top + 9);

  if (i === null || i < 0 || i >= m.samples.length) {
    g.selectAll("line.cursorline,circle.cursordot").attr("display", "none");
    return;
  }
  var cx = x(m.samples[i].time);

  var line = g.select("line.cursorline");
  if (line.empty()) line = g.append("line").attr("class", "cursorline");
  line
    .attr("display", null)
    .attr("x1", cx)
    .attr("x2", cx)
    .attr("y1", M.top)
    .attr("y2", H - M.bottom);

  var dots = m.series
    .map(function (s, k) {
      return { s: s, v: self.stacked[k] && self.stacked[k][i] };
    })
    .filter(function (d) {
      return d.v && d.v[1] - d.v[0] > 0;
    });

  g.selectAll("circle.cursordot")
    .data(dots, function (d) {
      return d.s.key;
    })
    .join("circle")
    .attr("class", "cursordot")
    .attr("display", null)
    .attr("r", 2.6)
    .attr("stroke", function (d) {
      return d.s.color;
    })
    .attr("cx", cx)
    .attr("cy", function (d) {
      return y(d.v[1]);
    });
};

Chart.prototype.drawNav = function () {
  var self = this;
  var m = this.model;
  if (!m || !m.samples.length) return;
  var W = this.navEl.clientWidth;
  var H = this.navEl.clientHeight;
  if (W < 60 || H < 30) return;

  this.navSvg.attr("viewBox", "0 0 " + W + " " + H);
  this.navSvg.selectAll("*").remove();
  var g = this.navSvg.append("g");

  var x = d3
    .scaleTime()
    .domain([m.samples[0].time, m.samples[m.samples.length - 1].time])
    .range([NM.left, W - NM.right]);
  var y = d3.scaleLinear().domain([0, m.yMax]).range([H - NM.bottom, NM.top]);

  var usedArea = d3
    .area()
    .x(function (d) {
      return x(d.time);
    })
    .y0(y(0))
    .y1(function (d) {
      return y(d.used);
    });
  g.append("path").attr("class", "navarea").attr("d", usedArea(m.samples) || "");

  var swapMax = m.samples.reduce(function (mx, s) {
    return Math.max(mx, s.swapUsed);
  }, 0);
  if (swapMax > 0) {
    var ys = d3.scaleLinear().domain([0, swapMax]).range([H - NM.bottom, NM.top + 4]);
    var swapLine = d3
      .line()
      .x(function (d) {
        return x(d.time);
      })
      .y(function (d) {
        return ys(d.swapUsed);
      });
    g.append("path").attr("class", "navswap").attr("d", swapLine(m.samples) || "");
    g.append("text")
      .attr("class", "navlabel")
      .attr("x", W - NM.right + 6)
      .attr("y", NM.top + 10)
      .attr("fill", "var(--crit)")
      .text("swap");
  }

  g.append("text")
    .attr("class", "navlabel")
    .attr("x", NM.left)
    .attr("y", H - 3)
    .text("whole run");

  var times = m.samples.map(function (s) {
    return s.time;
  });

  var brush = d3
    .brushX()
    .extent([
      [NM.left, NM.top],
      [W - NM.right, H - NM.bottom],
    ])
    .on("brush end", function (e) {
      var sel = e.selection;
      if (!sel) {
        self.range = [0, m.samples.length - 1];
      } else {
        var a = d3.bisectCenter(times, x.invert(sel[0]));
        var bIdx = d3.bisectCenter(times, x.invert(sel[1]));
        if (bIdx - a < 2) bIdx = Math.min(m.samples.length - 1, a + 2);
        if (bIdx - a < 2) a = Math.max(0, bIdx - 2);
        self.range = [a, bIdx];
      }
      self.draw();
    });

  var bg = g.append("g").attr("class", "brush").call(brush);
  this.navSvg.on("dblclick", function () {
    self.range = [0, m.samples.length - 1];
    bg.call(brush.move, null);
    self.draw();
  });
};

/* ==================================================================
   table — sortable process list bound to the chart cursor
   ================================================================== */

function Table(tbody, thead, onPick, onHover) {
  var self = this;
  this.tbody = d3.select(tbody);
  this.onPick = onPick;
  this.onHover = onHover;
  this.model = null;
  this.cursor = 0;
  this.picked = null;
  this.sortKey = "peak";
  this.sortDir = -1;

  d3.select(thead)
    .selectAll("th")
    .each(function () {
      var th = this;
      th.addEventListener("click", function () {
        var key = th.dataset.sort;
        if (self.sortKey === key) self.sortDir *= -1;
        else {
          self.sortKey = key;
          self.sortDir = key === "label" ? 1 : -1;
        }
        d3.select(thead).selectAll("th").classed("is-sorted", false);
        th.classList.add("is-sorted");
        self.render();
      });
    });
}

Table.prototype.setModel = function (model) {
  this.model = model;
  this.cursor = model.worstIndex;
  this.render();
};

Table.prototype.setCursor = function (i) {
  if (!this.model) return;
  this.cursor = Math.max(0, Math.min(this.model.samples.length - 1, i));
  if (this.sortKey === "cursor") this.render();
  else this.updateValues();
};

Table.prototype.setPicked = function (key) {
  var self = this;
  this.picked = key;
  this.tbody
    .selectAll("tr")
    .classed("is-picked", function (d) {
      return d.key === self.picked;
    })
    .classed("is-dim", function (d) {
      return self.picked !== null && d.key !== self.picked;
    });
};

Table.prototype.sorted = function () {
  var self = this;
  if (!this.model) return [];
  var i = this.cursor;
  var dir = this.sortDir;
  return this.model.series.slice().sort(function (a, b) {
    switch (self.sortKey) {
      case "label":
        return dir * a.label.localeCompare(b.label);
      case "cursor":
        return dir * (a.values[i] - b.values[i]);
      case "conc":
        return dir * (a.maxConcurrent - b.maxConcurrent);
      default:
        return dir * (a.peak - b.peak);
    }
  });
};

Table.prototype.render = function () {
  var self = this;
  if (!this.model) return;

  var rows = this.tbody
    .selectAll("tr")
    .data(this.sorted(), function (d) {
      return d.key;
    })
    .join(function (enter) {
      var tr = enter.append("tr");
      var name = tr.append("td").attr("class", "col-name");
      name.append("div").attr("class", "namebar");
      var inner = name.append("div").attr("class", "nameinner");
      inner.append("span").attr("class", "swatch");
      inner.append("span").attr("class", "pname");
      name.append("span").attr("class", "pcmd");
      tr.append("td").attr("class", "col-num v-cursor");
      tr.append("td").attr("class", "col-num v-peak");
      tr.append("td").attr("class", "col-num v-conc");
      return tr;
    });

  rows.order();
  rows
    .on("click", function (_e, d) {
      self.picked = self.picked === d.key ? null : d.key;
      self.setPicked(self.picked);
      self.onPick(self.picked);
    })
    .on("pointerenter", function (_e, d) {
      self.onHover(d.key);
    })
    .on("pointerleave", function () {
      self.onHover(null);
    })
    .attr("title", function (d) {
      return d.detail ? d.label + " — " + d.detail : d.label;
    });

  rows.select("span.swatch").style("background", function (d) {
    return d.color;
  });
  rows.select("div.namebar").style("background", function (d) {
    return d.color;
  });
  rows.select("span.pname").text(function (d) {
    return d.label;
  });
  rows.select("span.pcmd").text(function (d) {
    return d.detail;
  });
  rows.select("td.v-peak").text(function (d) {
    return fmtKB(d.peak);
  });
  rows.select("td.v-conc").text(function (d) {
    return d.maxConcurrent ? String(d.maxConcurrent) : "—";
  });

  this.updateValues();
  this.setPicked(this.picked);
};

Table.prototype.updateValues = function () {
  var m = this.model;
  if (!m) return;
  var i = this.cursor;
  var max = 0;
  m.series.forEach(function (s) {
    if (s.values[i] > max) max = s.values[i];
  });

  var rows = this.tbody.selectAll("tr");
  rows
    .select("td.v-cursor")
    .text(function (d) {
      return d.values[i] > 0 ? fmtKB(d.values[i]) : "—";
    })
    .classed("is-zero", function (d) {
      return d.values[i] === 0;
    });
  rows.select("div.namebar").style("width", function (d) {
    return (max ? (d.values[i] / max) * 100 : 0) + "%";
  });
};

/* ==================================================================
   app — loading, grouping, readout, cross-linking
   ================================================================== */

function $(id) {
  var el = document.getElementById(id);
  if (!el) throw new Error("missing element #" + id);
  return el;
}

var samples = [];
var procs = [];
var groupBy = "comm";
var model = null;
var currentPick = null;

var chart = new Chart(
  $("plot"),
  $("nav"),
  function (i) {
    if (!model) return;
    var idx = i === null ? model.worstIndex : i;
    table.setCursor(idx);
    paintReadout(idx, i === null);
  },
  function (key) {
    currentPick = key;
    table.setPicked(key);
  }
);

var table = new Table(
  $("ptable-body"),
  document.querySelector("#ptable thead"),
  function (key) {
    currentPick = key;
    chart.setPicked(key);
  },
  // hovering a row previews it in the plot without committing a selection
  function (key) {
    chart.setPicked(key === null ? currentPick : key);
  }
);

function rebuild() {
  if (!samples.length) return;
  model = buildModel(samples, procs, groupBy);
  chart.setModel(model);
  table.setModel(model);
  paintReadout(model.worstIndex, true);

  var first = samples[0];
  var last = samples[samples.length - 1];
  var mins = Math.round((last.epoch - first.epoch) / 60);
  $("run-label").textContent =
    samples.length + " samples · " + fmtClock(first.time) + "–" + fmtClock(last.time) +
    " · " + mins + " min · " + fmtKB(model.memTotal) + " RAM";

  $("table-count").textContent = model.hasProcs
    ? model.groupCount + " " + (groupBy === "comm" ? "names" : "processes") +
    (model.hiddenCount ? ", " + model.hiddenCount + " folded into one band" : "")
    : "load procs.csv for the breakdown";

  $("chart-note").textContent = model.hasProcs
    ? "Move across the plot to read any moment. Click a band to isolate it."
    : "Showing total usage only — add procs.csv to break it down.";

  $("empty").classList.add("is-hidden");
}

function paintReadout(i, atWorst) {
  if (!model) return;
  var s = model.samples[i];
  if (!s) return;
  $("ro-time").textContent = fmtClock(s.time) + (atWorst ? "  (tightest)" : "");
  $("ro-used").textContent = fmtKB(s.used);
  var avail = $("ro-avail");
  avail.textContent = fmtKB(s.memAvail);
  avail.classList.toggle("is-low", s.low);
  $("ro-swap").textContent = s.swapTotal ? fmtKB(s.swapUsed) : "no swap";
  $("ro-load").textContent = s.load1.toFixed(2) + "  ·  " + s.procsRunning + " running";

  var w = model.samples[model.worstIndex];
  $("ro-worst").textContent = fmtKB(w.memAvail) + " free at " + fmtClock(w.time);
}

$("ro-worst").addEventListener("click", function () {
  if (model) chart.focusOn(model.worstIndex);
});

function ingest(name, text) {
  var head = text.slice(0, 400);
  if (/mem_total_kb/.test(head)) {
    samples = parseSystem(text);
    markPicker("file-system");
  } else if (/rss_kb/.test(head)) {
    procs = parseProcs(text);
    markPicker("file-procs");
  } else {
    showError(
      name + " doesn't look like a memwatch CSV. Expected a header row with mem_total_kb or rss_kb."
    );
    return;
  }
  if (samples.length) rebuild();
  else showError("Load system.csv too — procs.csv has no time axis on its own.");
}

function markPicker(id) {
  var p = $(id).closest(".pick");
  if (p) p.classList.add("is-set");
}

function showError(msg) {
  var box = $("empty");
  box.classList.remove("is-hidden");
  var e = box.querySelector(".err");
  if (!e) {
    e = document.createElement("p");
    e.className = "err";
    box.querySelector(".empty__inner").appendChild(e);
  }
  e.textContent = msg;
}

function readFile(f) {
  var r = new FileReader();
  r.onload = function () {
    ingest(f.name, String(r.result));
  };
  r.readAsText(f);
}

["file-system", "file-procs"].forEach(function (id) {
  $(id).addEventListener("change", function (e) {
    var f = e.target.files && e.target.files[0];
    if (f) readFile(f);
  });
});

var app = $("app");
app.addEventListener("dragover", function (e) {
  e.preventDefault();
  app.classList.add("is-dragging");
});
app.addEventListener("dragleave", function (e) {
  if (e.relatedTarget === null) app.classList.remove("is-dragging");
});
app.addEventListener("drop", function (e) {
  e.preventDefault();
  app.classList.remove("is-dragging");
  var files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
  // system.csv first: procs rows are dropped unless the time axis exists
  files.sort(function (a, b) {
    return a.name.indexOf("system") >= 0 ? -1 : b.name.indexOf("system") >= 0 ? 1 : 0;
  });
  files.forEach(readFile);
});

document.querySelectorAll(".grouping button").forEach(function (b) {
  b.addEventListener("click", function () {
    document.querySelectorAll(".grouping button").forEach(function (o) {
      o.classList.remove("is-on");
    });
    b.classList.add("is-on");
    groupBy = b.dataset.group;
    currentPick = null;
    rebuild();
  });
});

// serving this page from a run directory should just work.
// (Opened as a file:// URL the browser blocks this, so drag-and-drop
// is the path there — the empty screen says so.)
Promise.all([
  fetch("system.csv").then(function (r) {
    return r.ok ? r.text() : null;
  }),
  fetch("procs.csv").then(function (r) {
    return r.ok ? r.text() : null;
  }),
])
  .then(function (res) {
    if (!res[0] || !/mem_total_kb/.test(res[0].slice(0, 400))) return;
    samples = parseSystem(res[0]);
    markPicker("file-system");
    if (res[1] && /rss_kb/.test(res[1].slice(0, 400))) {
      procs = parseProcs(res[1]);
      markPicker("file-procs");
    }
    rebuild();
  })
  .catch(function () {
    /* no run alongside the page; wait for a drop */
  });
