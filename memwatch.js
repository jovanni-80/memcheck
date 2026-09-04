"use strict";

/* ==================================================================
    data — CSV parsing, grouping, and the stack model
    ================================================================== */

/* Palette: warm-to-cool spread that stays separable on the petrol
    ground. Ordered so the largest consumer takes the strongest teal. */
var PALETTE = [
  "#4fc3b0", "#e8a33d", "#7ea6f0", "#c98be0", "#e2757f", "#86c765",
  "#5fb8d8", "#dcc45e", "#a58cf0", "#e0894f", "#6fd3a0", "#d47ab3",
  "#8fb4c9", "#e0a58c", "#9fd07a", "#b39ae0", "#e08fa0", "#6ec2c9",
  "#c9b06e", "#7f9fe0", "#a0d8c0", "#d9a0d0", "#c2c96e", "#8ec4e8",
];

/* Build steps, as tagged by the sampler. Fixed colours: compile and link
    should look the same in every run rather than shifting with rank. */
var ROLE_LABEL = {
  compile: "compile",
  link: "link",
  assemble: "assemble",
  archive: "archive",
  preprocess: "preprocess",
  postlink: "post-link",
  other: "everything else",
};
var ROLE_COLOR = {
  compile: "#4fc3b0",
  link: "#e8a33d",
  assemble: "#7ea6f0",
  archive: "#c98be0",
  preprocess: "#86c765",
  postlink: "#dcc45e",
  other: "#5b6f7d",
};

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
    // shmem/slab/pagetables arrived in a later version of the sampler;
    // older runs simply report them as zero
    var shmem = num(r.shmem_kb);
    var slab = num(r.slab_kb);
    var pagetables = num(r.pagetables_kb);
    var kstack = num(r.kernelstack_kb);
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
      shmem: shmem,
      slab: slab,
      sreclaimable: num(r.sreclaimable_kb),
      sunreclaim: num(r.sunreclaim_kb),
      pagetables: pagetables,
      kstack: kstack,
      anon: num(r.anon_kb),
      mapped: num(r.mapped_kb),
      hugetlb: num(r.hugetlb_kb),
      procsLogged: num(r.procs_logged),
      metric: r.metric || "rss",
      kernel: shmem + slab + pagetables + kstack,
      used: Math.max(0, memTotal - memAvail),
      swapUsed: Math.max(0, swapTotal - swapFree),
    });
  });
  out.sort(function (a, b) {
    return a.epoch - b.epoch;
  });
  return out;
}

function emptyProcs() {
  return { n: 0, epoch: null, idIdx: null, rss: null, vsz: null, ids: [] };
}

/**
  * procs.csv → columnar typed arrays.
  *
  * Logging every process means hundreds of thousands of rows, so this
  * avoids one object per row. Identity (comm/ppid/cmdline) is written by
  * the sampler only when a pid first appears, so it is filled forward
  * here; a pid that comes back under a different comm gets a fresh
  * identity rather than inheriting the dead process's name.
  *
  * Handles both the old wide layout and the current compact one by
  * looking columns up by name.
  */
function parseProcs(text) {
  var nl = text.indexOf("\n");
  if (nl < 0) return emptyProcs();
  var header = d3.csvParseRows(text.slice(0, nl))[0].map(function (h) {
    return h.trim();
  });
  var col = {};
  header.forEach(function (h, i) {
    col[h] = i;
  });
  var iEpoch = col.epoch, iPid = col.pid, iRss = col.rss_kb,
    iVsz = col.vsz_kb, iComm = col.comm, iPpid = col.ppid,
    iCmd = col.cmdline, iRole = col.role;
  if (iEpoch === undefined || iPid === undefined || iRss === undefined) {
    return emptyProcs();
  }

  var cap = Math.max(1024, Math.ceil(text.length / 26));
  var epoch = new Float64Array(cap);
  var idIdx = new Int32Array(cap);
  var rss = new Float64Array(cap);
  var vsz = new Float64Array(cap);
  var n = 0;

  var ids = [];
  var live = new Map(); // pid -> index into ids

  function grow() {
    cap *= 2;
    var a = new Float64Array(cap); a.set(epoch); epoch = a;
    var b = new Int32Array(cap); b.set(idIdx); idIdx = b;
    var c = new Float64Array(cap); c.set(rss); rss = c;
    var d = new Float64Array(cap); d.set(vsz); vsz = d;
  }

  d3.csvParseRows(text, function (row, i) {
    if (i === 0) return null;
    var e = +row[iEpoch];
    if (!e) return null;
    var pid = +row[iPid];
    var comm = iComm === undefined ? "" : row[iComm] || "";

    var idx = live.has(pid) ? live.get(pid) : -1;
    if (comm !== "" && (idx < 0 || ids[idx].comm !== comm)) {
      // first sighting, or this pid has been recycled onto another program
      idx = ids.length;
      ids.push({
        pid: pid,
        comm: comm,
        ppid: iPpid === undefined ? 0 : +row[iPpid] || 0,
        cmdline: iCmd === undefined ? "" : row[iCmd] || "",
        role: iRole === undefined ? "" : row[iRole] || "other",
      });
      live.set(pid, idx);
    } else if (idx < 0) {
      // compact row for a pid whose identity row we never saw
      idx = ids.length;
      ids.push({ pid: pid, comm: "pid " + pid, ppid: 0, cmdline: "", role: "other" });
      live.set(pid, idx);
    }

    if (n === cap) grow();
    epoch[n] = e;
    idIdx[n] = idx;
    rss[n] = +row[iRss] || 0;
    vsz[n] = iVsz === undefined ? 0 : +row[iVsz] || 0;
    n++;
    return null;
  });

  return { n: n, epoch: epoch, idIdx: idIdx, rss: rss, vsz: vsz, ids: ids };
}

/* Shorten a cmdline to the bit that identifies the work: the last
    path-ish argument, which for a compile is usually the source file. */
function describe(cmdline, comm) {
  if (!cmdline || cmdline === "[" + comm + "]") return "";
  var parts = cmdline.split(/\s+/);
  for (var i = parts.length - 1; i >= 0; i--) {
    if (/\.(c|cc|cpp|cxx|c\+\+|m|mm|ii|s|o|a|so)$/i.test(parts[i])) return parts[i];
  }
  return cmdline.length > 90 ? cmdline.slice(0, 90) + "…" : cmdline;
}

function mkSeries(key, label, detail, color, values, synthetic) {
  var peak = 0, peakIndex = 0, total = 0, seen = 0;
  for (var i = 0; i < values.length; i++) {
    if (values[i] > 0) seen++;
    total += values[i];
    if (values[i] > peak) {
      peak = values[i];
      peakIndex = i;
    }
  }
  return {
    key: key, label: label, detail: detail, color: color, values: values,
    peak: peak, peakIndex: peakIndex, mean: seen ? total / seen : 0,
    seen: seen, maxConcurrent: 0, synthetic: !!synthetic,
  };
}

/**
  * Fold per-sample process rows into aligned series ready to stack.
  *
  * Two passes, because with every process logged there can be thousands
  * of distinct keys and a dense per-key array would be gigabytes. Pass
  * one accumulates scalars only (peak, total, concurrency) to rank the
  * keys; pass two allocates dense arrays for just the bands that will
  * actually be drawn, plus one for everything else.
  */
function buildModel(samples, procs, groupBy, topN) {
  topN = topN || 12;
  var n = samples.length;
  var indexOf = new Map();
  var i, k;
  for (i = 0; i < n; i++) indexOf.set(samples[i].epoch, i);

  var stats = new Map(); // key -> ranking scalars
  var rowKey = null;     // key per row, reused in pass two
  var rowSample = null;

  if (procs.n) {
    rowKey = new Int32Array(procs.n);
    rowSample = new Int32Array(procs.n);
    var keyIds = [];
    var keyIndex = new Map();
    var idKey = new Int32Array(procs.ids.length).fill(-1);

    // --- pass one: rank keys without storing anything per sample
    var curSample = -1;
    var bucket = new Map(); // key -> summed value within the current sample
    var bucketN = new Map();

    var flush = function () {
      bucket.forEach(function (v, key) {
        var st = stats.get(key);
        if (v > st.peak) {
          st.peak = v;
          st.peakIndex = curSample;
        }
        st.total += v;
        st.seen++;
        var c = bucketN.get(key);
        if (c > st.maxConcurrent) st.maxConcurrent = c;
      });
      bucket.clear();
      bucketN.clear();
    };

    for (i = 0; i < procs.n; i++) {
      var si = indexOf.get(procs.epoch[i]);
      if (si === undefined) {
        rowSample[i] = -1;
        rowKey[i] = -1;
        continue;
      }
      if (si !== curSample) {
        if (curSample >= 0) flush();
        curSample = si;
      }
      var id = procs.idIdx[i];
      var kid = idKey[id];
      if (kid < 0) {
        var idRec = procs.ids[id];
        var label, mapKey;
        if (groupBy === "role") {
          label = ROLE_LABEL[idRec.role] || idRec.role || "other";
          mapKey = "r:" + (idRec.role || "other");
        } else if (groupBy === "comm") {
          label = idRec.comm;
          mapKey = "c:" + idRec.comm;
        } else {
          label = idRec.comm + " " + idRec.pid;
          mapKey = "p:" + id;
        }
        if (keyIndex.has(mapKey)) {
          kid = keyIndex.get(mapKey);
        } else {
          kid = keyIds.length;
          keyIndex.set(mapKey, kid);
          keyIds.push(mapKey);
          stats.set(mapKey, {
            kid: kid, label: label, bestId: id, bestRss: -1,
            peak: 0, peakIndex: 0, total: 0, seen: 0, maxConcurrent: 0,
          });
        }
        idKey[id] = kid;
      }
      var key = keyIds[kid];
      rowKey[i] = kid;
      rowSample[i] = si;
      var val = procs.rss[i];
      bucket.set(key, (bucket.get(key) || 0) + val);
      bucketN.set(key, (bucketN.get(key) || 0) + 1);
      var st2 = stats.get(key);
      if (val > st2.bestRss) {
        st2.bestRss = val;
        st2.bestId = id;
      }
    }
    if (curSample >= 0) flush();
    var keyList = keyIds;
  }

  var series = [];
  var hiddenCount = 0;
  var groupCount = stats.size;

  if (procs.n) {
    var ranked = Array.from(stats.values()).sort(function (a, b) {
      return b.peak - a.peak;
    });
    var shown = ranked.slice(0, topN);
    hiddenCount = ranked.length - shown.length;

    // --- pass two: dense arrays for the drawn bands only
    var slot = new Int32Array(keyList.length).fill(-1);
    shown.forEach(function (st, idx) {
      slot[st.kid] = idx;
    });
    var arrays = shown.map(function () {
      return new Float64Array(n);
    });
    var restArr = hiddenCount ? new Float64Array(n) : null;

    for (i = 0; i < procs.n; i++) {
      var s2 = rowSample[i];
      if (s2 < 0) continue;
      var sl = slot[rowKey[i]];
      if (sl >= 0) arrays[sl][s2] += procs.rss[i];
      else if (restArr) restArr[s2] += procs.rss[i];
    }

    shown.forEach(function (st, idx) {
      var idRec = procs.ids[st.bestId];
      series.push({
        key: "k" + st.kid,
        label: st.label,
        detail:
          groupBy === "role"
            ? st.seen + " samples, " + st.maxConcurrent + " at once at the busiest"
            : describe(idRec.cmdline, idRec.comm),
        color:
          groupBy === "role"
            ? ROLE_COLOR[st.label] || ROLE_COLOR[idRec.role] || PALETTE[idx % PALETTE.length]
            : PALETTE[idx % PALETTE.length],
        values: arrays[idx],
        peak: st.peak,
        peakIndex: st.peakIndex,
        mean: st.seen ? st.total / st.seen : 0,
        seen: st.seen,
        maxConcurrent: st.maxConcurrent,
        synthetic: false,
      });
    });

    if (restArr) {
      series.push(
        mkSeries("__rest__", hiddenCount + " smaller processes",
          "everything below the drawn bands, summed", "#5b6f7d", restArr, true)
      );
    }
  }

  // --- memory that belongs to no process, straight from /proc/meminfo
  var hasKernel = samples.some(function (s) {
    return s.kernel > 0;
  });
  var logged = new Float64Array(n);
  for (i = 0; i < n; i++) {
    for (k = 0; k < series.length; k++) logged[i] += series[k].values[i];
  }

  var overshoot = 0;
  if (procs.n && hasKernel) {
    var shm = new Float64Array(n), slb = new Float64Array(n), pgt = new Float64Array(n);
    for (i = 0; i < n; i++) {
      shm[i] = samples[i].shmem;
      slb[i] = samples[i].slab;
      pgt[i] = samples[i].pagetables + samples[i].kstack;
    }
    if (d3.max(shm)) {
      series.push(mkSeries("__shmem__", "tmpfs / shared memory",
        "Shmem: tmpfs files and shared segments, owned by no process", "#4a5b47", shm, true));
    }
    if (d3.max(slb)) {
      series.push(mkSeries("__slab__", "kernel slab",
        "dentry and inode caches — millions of build files live here", "#42505f", slb, true));
    }
    if (d3.max(pgt)) {
      series.push(mkSeries("__pgt__", "page tables + kernel stacks",
        "PageTables + KernelStack", "#4d4657", pgt, true));
    }
  }

  var known = new Float64Array(n);
  for (i = 0; i < n; i++) {
    for (k = 0; k < series.length; k++) known[i] += series[k].values[i];
  }

  if (procs.n) {
    var unacc = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var gap = samples[i].used - known[i];
      if (gap > 0) unacc[i] = gap;
      else if (-gap > overshoot) overshoot = -gap;
    }
    if (d3.max(unacc) > 0) {
      series.push(mkSeries("__unaccounted__", "unaccounted",
        "in use per the kernel, but claimed by nothing above", "#33454f", unacc, true));
    }
  } else {
    // no procs.csv: show total usage so the chart still reads
    var tv = new Float64Array(n);
    for (i = 0; i < n; i++) tv[i] = samples[i].used;
    series.push(mkSeries("__used__", "in use",
      "load procs.csv to break this down by process", "#4a6270", tv, true));
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
  var peakStack = 0;
  for (i = 0; i < n; i++) {
    var t = 0;
    for (k = 0; k < series.length; k++) t += series[k].values[i];
    if (t > peakStack) peakStack = t;
  }

  return {
    samples: samples,
    series: series,
    logged: logged,
    memTotal: memTotal,
    cgroupMax: cgroupMax > 0 && cgroupMax < memTotal * 4 ? cgroupMax : 0,
    yMax: Math.max(memTotal, peakUsed, peakStack) * 1.02 || 1,
    worstIndex: worstIndex,
    hasProcs: procs.n > 0,
    hasKernel: hasKernel,
    groupCount: groupCount,
    hiddenCount: hiddenCount,
    overshoot: overshoot,
    metric: n ? samples[0].metric : "rss",
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

var M = { top: 16, right: 80, bottom: 22, left: 56 };
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
  this.tip = d3.select(plot).append("div").attr("class", "tip").style("display", "none");
  this.hover = false;
  this.pointerY = 0;
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
    root.append("path").attr("class", "usedline");
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

  var usedLine = d3
    .line()
    .x(function (d) {
      return x(d.time);
    })
    .y(function (d) {
      return y(d.used);
    });
  root.select("path.usedline").attr("d", usedLine(m.samples) || "");

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
      var pt = d3.pointer(e);
      var abs = Math.floor(i0) + d3.bisectCenter(times, x.invert(pt[0]));
      self.hover = true;
      self.pointerY = pt[1];
      self.cursor = abs;
      self.drawCursor();
      self.onScrub(abs);
    })
    .on("pointerleave", function () {
      self.hover = false;
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
    this.tip.style("display", "none");
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

  this.drawTip(i, cx);
};

/* Tooltip: the total the machine is holding at the cursor, plus the one
    band the pointer is actually inside. The table carries the full
    breakdown, so this stays to three lines. */
Chart.prototype.drawTip = function (i, cx) {
  var m = this.model;
  var y = this.yScale;
  if (!m || !y || !this.hover) {
    this.tip.style("display", "none");
    return;
  }

  var s = m.samples[i];
  var W = this.plot.clientWidth;
  var H = this.plot.clientHeight;

  // which layer is under the pointer, in stacked (cumulative) space
  var v = y.invert(this.pointerY);
  var band = null;
  for (var k = 0; k < m.series.length; k++) {
    var seg = this.stacked[k] && this.stacked[k][i];
    if (seg && v >= seg[0] && v < seg[1] && seg[1] - seg[0] > 0) {
      band = m.series[k];
      break;
    }
  }

  var html =
    '<span class="tip__t">' + fmtClock(s.time) + "</span>" +
    '<div class="tip__row"><span class="tip__k">in use</span>' +
    '<span class="tip__v">' + fmtKB(s.used) + "</span></div>" +
    '<div class="tip__row"><span class="tip__k">available</span>' +
    '<span class="tip__v' + (s.low ? " is-low" : "") + '">' + fmtKB(s.memAvail) + "</span></div>";

  if (band) {
    html +=
      '<div class="tip__band"><span class="tip__sw" style="background:' + band.color + '"></span>' +
      '<span class="tip__name">' + escapeHtml(band.label) + "</span>" +
      '<span class="tip__bv">' + fmtKB(band.values[i]) + "</span></div>";
  }

  this.tip.style("display", null).html(html);

  var node = this.tip.node();
  var tw = node.offsetWidth || 170;
  var th = node.offsetHeight || 64;
  var left = cx + 14;
  if (left + tw > W - 4) left = cx - 14 - tw; // flip before running off the right
  if (left < 2) left = 2;
  var top = Math.min(Math.max(this.pointerY - th - 12, M.top), H - M.bottom - th);
  this.tip.style("left", left + "px").style("top", Math.max(2, top) + "px");
};

function escapeHtml(t) {
  return String(t).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}

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
var procs = emptyProcs();
var groupBy = "comm";
var bandCount = 12;
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
  model = buildModel(samples, procs, groupBy, bandCount);
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
    ? model.groupCount + " " +
    (groupBy === "comm" ? "names" : groupBy === "role" ? "build steps" : "processes") +
    (model.hiddenCount ? ", " + model.hiddenCount + " folded into one band" : "") +
    (model.metric === "pss" ? " · PSS" : "")
    : "load procs.csv for the breakdown";

  var note;
  if (!model.hasProcs) {
    note = "Showing total usage only — add procs.csv to break it down.";
  } else if (model.overshoot > 1024) {
    // sum of RSS above what the kernel reports in use: shared pages are
    // counted once per process, so the stack can exceed reality
    note = "Process totals overshoot by up to " + fmtKB(model.overshoot) +
      " — shared pages count once per process. Re-run the sampler with -P for PSS.";
  } else if (!model.hasKernel) {
    note = "Click a band to isolate it. This run predates kernel accounting — re-record for the shmem/slab breakdown.";
  } else {
    note = "Move across the plot to read any moment. Click a band to isolate it.";
  }
  $("chart-note").textContent = note;

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

$("band-count").addEventListener("change", function (e) {
  bandCount = +e.target.value;
  currentPick = null;
  rebuild();
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
