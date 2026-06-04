(function () {
  var ws, running = false, ref = 0, connected = false, plot = false, plotFrozen = false;
  var viewMode = 'gauge';
  var settingsOpen = false, settingsSaved = false;
  var lastData = null;
  var channelMask = 0x0F;
  var cylCount = 4;
  var visibleChs = [true, true, true, true];
  var viewPts    = window.matchMedia('(max-width: 520px)').matches ? 100 : 400;
  var viewOffset = 0;  // 0 = newest, positive = steps back from the right
  var waveSpan   = 200;

  // Wave data: always accumulated, per-channel array of {t, v} (v = kPa × 10 integer)
  var WAVE_MAX = 1200;  // ~5.5 s at 215 Hz
  var waveChs = [[], [], [], []];
  var waveRaf = null;
  var CH_COLORS = ['#4caf50', '#42a5f5', '#ffc107', '#ef5350'];

  function appendWave(msg) {
    var t0 = msg.t0 || 0, dt = msg.dt || 5, chs = msg.chs || [];
    for (var c = 0; c < chs.length && c < 4; c++) {
      for (var i = 0; i < chs[c].length; i++)
        waveChs[c].push({t: t0 + i * dt, v: chs[c][i] / 10});
      if (waveChs[c].length > WAVE_MAX)
        waveChs[c] = waveChs[c].slice(waveChs[c].length - WAVE_MAX);
    }
    updateScrollSlider();
  }

  function maxDataLen() {
    var n = 0;
    for (var c = 0; c < cylCount; c++) n = Math.max(n, waveChs[c].length);
    return n;
  }

  function updateScrollSlider() {
    var maxOff = Math.max(0, maxDataLen() - viewPts);
    var row    = document.getElementById('wave-scroll-row');
    var sl     = document.getElementById('wave-scroll');
    if (maxOff > 0) {
      sl.max = maxOff;
      // keep viewOffset clamped; if at zero (live view) stay at max (right edge)
      viewOffset = Math.min(viewOffset, maxOff);
      sl.value = maxOff - viewOffset;   // right = newest (offset 0)
      row.style.display = '';
    } else {
      viewOffset = 0;
      row.style.display = 'none';
    }
  }

  window.onWaveZoom = function(val) {
    viewPts = parseInt(val);
    document.getElementById('wave-zoom-val').textContent = val;
    updateScrollSlider();
  };

  window.onWaveSpan = function(val) {
    waveSpan = parseInt(val);
    document.getElementById('wave-span-val').textContent = val;
  };

  window.onWaveScroll = function(val) {
    var sl = document.getElementById('wave-scroll');
    viewOffset = parseInt(sl.max) - parseInt(val);  // right = 0 = newest
  };

  function niceStep(rough) {
    var p = Math.pow(10, Math.floor(Math.log10(rough || 1)));
    var f = rough / p;
    return f < 1.5 ? p : f < 3.5 ? 2*p : f < 7.5 ? 5*p : 10*p;
  }

  function drawWave() {
    var canvas = document.getElementById('wave-canvas');
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(0, 0, w, h);

    var mobile = window.matchMedia('(max-width: 520px)').matches;
    var ml = mobile ? 34 : 46, mr = 8, mt = 14, mb = mobile ? 16 : 22;
    var pw = w - ml - mr, ph = h - mt - mb;

    // Slice viewPts samples at viewOffset from the end, per channel
    var showLines = plot || plotFrozen;
    var slices = [];
    var yMin = Infinity, yMax = -Infinity;
    if (showLines) {
      for (var c = 0; c < cylCount; c++) {
        var d = waveChs[c];
        var end   = d.length - viewOffset;
        var start = Math.max(0, end - viewPts);
        var sl = d.slice(start, end);
        slices.push(sl);
        if (!visibleChs[c]) continue;
        for (var i = 0; i < sl.length; i++) {
          yMin = Math.min(yMin, sl[i].v); yMax = Math.max(yMax, sl[i].v);
        }
      }
    }
    var center = isFinite(yMin) ? (yMin + yMax) / 2 : 200;
    yMin = center - waveSpan / 2;
    yMax = center + waveSpan / 2;

    // right-aligned index mapping: newest sample always at the right edge
    function tx(off) { return ml + off / viewPts * pw; }
    function ty(v)   { return mt + (1 - (v - yMin) / (yMax - yMin)) * ph; }

    // Y grid + labels
    var step = niceStep((yMax - yMin) / 4);
    ctx.lineWidth = 1;
    for (var y = Math.ceil(yMin / step) * step; y <= yMax; y += step) {
      var yy = ty(y);
      ctx.strokeStyle = '#2a2a2a'; ctx.beginPath(); ctx.moveTo(ml, yy); ctx.lineTo(ml + pw, yy); ctx.stroke();
      ctx.fillStyle = '#555'; ctx.font = (mobile ? '9' : '10') + 'px sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(y.toFixed(0), ml - 4, yy + 3);
    }
    ctx.fillStyle = '#444'; ctx.font = '9px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('kPa', 2, mt + 9);

    // Legend — always shown
    for (var c = 0; c < cylCount; c++) {
      var lx = ml + 6 + c * 58;
      ctx.fillStyle = CH_COLORS[c]; ctx.fillRect(lx, mt + 2, 12, 2);
      ctx.fillStyle = '#999'; ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText('Cyl ' + (c + 1), lx + 15, mt + 6);
    }

    // Channel lines — when plot is active or frozen
    if (showLines && slices.length > 0) {
      for (var c = 0; c < cylCount; c++) {
        var sl = slices[c]; if (!visibleChs[c] || sl.length < 2) continue;
        var off = viewPts - sl.length;
        ctx.strokeStyle = CH_COLORS[c]; ctx.lineWidth = 1.5; ctx.beginPath();
        for (var i = 0; i < sl.length; i++) {
          var px = tx(off + i), py = ty(sl[i].v);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      if (plotFrozen) {
        ctx.fillStyle = '#666'; ctx.font = '11px sans-serif'; ctx.textAlign = 'right';
        ctx.fillText('Frozen', ml + pw - 4, mt + 12);
      }
    } else if (!showLines) {
      ctx.fillStyle = '#444'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('Press Start Plot to begin', w / 2, h / 2);
    }
  }

  function startWaveRender() {
    if (waveRaf) return;
    function tick() { drawWave(); waveRaf = requestAnimationFrame(tick); }
    waveRaf = requestAnimationFrame(tick);
  }

  function showView() {
    var n = document.getElementById('grid').children.length;
    if (n > 0) { buildGrid(n); if (lastData) update(lastData); }
  }

  // Gauge geometry — viewBox "0 0 260 150", semicircle, 0-140 kPa left→right
  var G = { min: 0, max: 140, cx: 130, cy: 140, r: 90, sw: 14 };

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------

  function connect() {
    ws = new WebSocket('ws://' + location.host + '/ws');
    ws.onopen = function () {
      connected = true;
      document.getElementById('dot').className = 'ok';
      document.getElementById('btn').disabled = false;
      document.getElementById('btn_usb').disabled = false;
      ws.send(JSON.stringify({ cmd: 'get_settings' }));
    };
    ws.onclose = function () {
      connected = false;
      document.getElementById('dot').className = '';
      document.getElementById('btn').disabled = true;
      document.getElementById('btn_usb').disabled = true;
      setTimeout(connect, 2000);
    };
    ws.onmessage = function (e) {
      var d;
      try { d = JSON.parse(e.data); } catch (_) { return; }
      if (d.type === 'wave') { appendWave(d); return; }
      if (d.type === 'settings') {
        populateSettings(d);
        if (!running) {
          var mask = d.channel_mask || 0x0F;
          var r = d.reference_channel || 0;
          var n = 0; for (var i = 0; i < 4; i++) if (mask & (1 << i)) n++;
          update({ rpm: 0, ref: r,
            cylinders: Array.from({length: n}, function () { return { kpa: 0, delta_kpa: 0 }; })
          });
        }
        return;
      }
      if (d.type === 'settings_saved') { showSettingsMsg('Saved', 'ok'); return; }
      if (d.type) return;  // ignore cal_progress / cal_complete
      update(d);
    };
  }

  // -------------------------------------------------------------------------
  // Sync status
  // -------------------------------------------------------------------------

  function updateStatus(cyls) {
    var el = document.getElementById('status');
    if (!running) { el.textContent = '--'; el.className = ''; return; }
    var maxDelta = 0;
    cyls.forEach(function (c, i) {
      if (i !== ref) maxDelta = Math.max(maxDelta, Math.abs(c.delta_kpa));
    });
    if (maxDelta < 5) {
      el.textContent = 'Synchronized';
      el.className   = 'sync';
    } else if (maxDelta < 10) {
      el.textContent = 'Almost Synchronized';
      el.className   = 'almost';
    } else {
      el.textContent = 'Desynchronized';
      el.className   = 'desync';
    }
  }

  // -------------------------------------------------------------------------
  // Gauge helpers
  // -------------------------------------------------------------------------

  function cylColor(absDelta, isRef) {
    if (isRef || absDelta < 5)  return '#4caf50';
    if (absDelta < 10)          return '#ffc107';
    return '#ef5350';
  }

  function makeSvg(kpa, color) {
    var cx = G.cx, cy = G.cy, r = G.r, sw = G.sw;
    var lx = cx - r, rx = cx + r;  // arc left (0 kPa) and right (140 kPa) endpoints

    // Clamp fraction; avoid degenerate arcs at exact 0° or 180°
    var f  = Math.min(0.9999, Math.max(0.0001, (kpa - G.min) / (G.max - G.min)));
    // angle from positive x-axis: π at kpa=0 (left), 0 at kpa=140 (right)
    var a  = Math.PI * (1 - f);
    var ex = (cx + r * Math.cos(a)).toFixed(1);
    var ey = (cy - r * Math.sin(a)).toFixed(1);  // SVG y-axis points down

    // sweep-flag=1 → clockwise on screen → from left (9 o'clock) goes UP through top → upper semicircle ✓
    var bgArc = 'M ' + lx + ' ' + cy + ' A ' + r + ' ' + r + ' 0 0 1 ' + rx + ' ' + cy;
    var fgArc = 'M ' + lx + ' ' + cy + ' A ' + r + ' ' + r + ' 0 0 1 ' + ex + ' ' + ey;

    var s = '<svg viewBox="0 0 260 150" width="100%" xmlns="http://www.w3.org/2000/svg">';

    // Background (full semicircle) and foreground (filled to current value)
    s += '<path d="' + bgArc + '" stroke="#282828" stroke-width="' + sw + '" fill="none" stroke-linecap="round"/>';
    s += '<path d="' + fgArc + '" stroke="' + color + '" stroke-width="' + sw + '" fill="none" stroke-linecap="round"/>';

    // Scale ticks and labels at every 20 kPa
    var rTi = r + sw / 2 + 3;   // tick inner radius (just outside arc)
    var rTo = rTi + 8;           // tick outer radius
    var rLb = rTo + 12;          // label centre radius
    [0, 20, 40, 60, 80, 100, 120, 140].forEach(function (v) {
      var ta = Math.PI * (1 - v / G.max);
      var ca = Math.cos(ta), sa = Math.sin(ta);
      var x1 = (cx + rTi * ca).toFixed(1), y1 = (cy - rTi * sa).toFixed(1);
      var x2 = (cx + rTo * ca).toFixed(1), y2 = (cy - rTo * sa).toFixed(1);
      var lbx = (cx + rLb * ca).toFixed(1), lby = (cy - rLb * sa + 3.5).toFixed(1);
      s += '<line x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'" stroke="#484848" stroke-width="1.5"/>';
      s += '<text x="'+lbx+'" y="'+lby+'" text-anchor="middle" fill="#555" font-size="9" font-family="sans-serif">'+v+'</text>';
    });

    // Current value in the centre of the gauge
    s += '<text x="' + cx + '" y="' + (cy - 22) + '" text-anchor="middle" fill="#eee" font-size="22" font-weight="700" font-family="sans-serif">' + kpa.toFixed(1) + '</text>';
    s += '<text x="' + cx + '" y="' + (cy - 6)  + '" text-anchor="middle" fill="#555" font-size="9"  font-family="sans-serif">kPa</text>';

    s += '</svg>';
    return s;
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  function update(d) {
    lastData = d;
    ref = d.ref || 0;
    document.getElementById('rpm').textContent = d.rpm > 0 ? d.rpm + ' RPM' : '-- RPM';

    var cyls = (d.cylinders || []).slice(0, cylCount);
    updateStatus(cyls);

    var grid = document.getElementById('grid');
    if (grid.children.length !== cylCount) buildGrid(cylCount);

    cyls.forEach(function (c, i) {
      var card     = grid.children[i];
      var isRef    = (i === ref);
      var absDelta = Math.abs(c.delta_kpa);
      var color    = cylColor(absDelta, isRef);
      var dText    = isRef ? 'ref' : (c.delta_kpa >= 0 ? '+' : '') + c.delta_kpa.toFixed(2) + ' kPa';
      var dCls     = isRef ? 'zero' : (absDelta < 0.5 ? 'zero' : c.delta_kpa > 0 ? 'pos' : 'neg');

      if (viewMode === 'gauge') {
        card.className = 'gauge-card' + (isRef ? ' ref' : '');
        card.querySelector('.gauge-svg').innerHTML = makeSvg(c.kpa, color);
        var dt = card.querySelector('.gauge-delta');
        dt.textContent = dText;
        dt.className   = 'gauge-delta ' + dCls;
      } else {
        card.className = 'cyl' + (isRef ? ' ref' : '');
        card.querySelector('.cyl-kpa').textContent = c.kpa.toFixed(1);
        var dt = card.querySelector('.cyl-delta');
        dt.textContent = dText;
        dt.className   = 'cyl-delta ' + dCls;
      }
    });
  }

  function buildWaveControls() {
    document.getElementById('wave-zoom').value = viewPts;
    document.getElementById('wave-zoom-val').textContent = viewPts;
    var ctrl = document.getElementById('wave-ch-btns');
    ctrl.innerHTML = '';
    for (var c = 0; c < cylCount; c++) {
      (function(ch) {
        var btn = document.createElement('button');
        btn.textContent = 'Cyl ' + (ch + 1);
        btn.style.color = CH_COLORS[ch];
        btn.style.borderColor = CH_COLORS[ch];
        btn.className = visibleChs[ch] ? '' : 'off';
        btn.onclick = function() {
          visibleChs[ch] = !visibleChs[ch];
          btn.className = visibleChs[ch] ? '' : 'off';
        };
        ctrl.appendChild(btn);
      }(c));
    }
  }

  function buildGrid(n) {
    var grid = document.getElementById('grid');
    grid.innerHTML = '';
    for (var i = 0; i < n; i++) {
      grid.innerHTML += viewMode === 'gauge'
        ? '<div class="gauge-card">' +
            '<div class="gauge-label">Cyl ' + (i + 1) + '</div>' +
            '<div class="gauge-svg"></div>' +
            '<div class="gauge-delta zero">---</div>' +
          '</div>'
        : '<div class="cyl">' +
            '<div class="cyl-label">Cyl ' + (i + 1) + '</div>' +
            '<div class="cyl-kpa">--.-</div>' +
            '<div class="cyl-unit">kPa</div>' +
            '<div class="cyl-delta zero">---</div>' +
          '</div>';
    }
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  window.toggleSettings = function () {
    settingsOpen = !settingsOpen;
    document.getElementById('settings-panel').style.display = settingsOpen ? 'block' : 'none';
    document.getElementById('status').style.display         = settingsOpen ? 'none' : '';
    document.getElementById('grid').style.display           = settingsOpen ? 'none' : '';
    document.getElementById('wave-wrap').style.display      = settingsOpen ? 'none' : '';
    if (settingsOpen) {
      settingsSaved = false;
    } else if (settingsSaved) {
      location.reload();
      return;
    }
    var btn = document.getElementById('btn_settings');
    btn.textContent = settingsOpen ? '✕' : '⚙';
    btn.className   = 'hbtn' + (settingsOpen ? ' active' : '');
    if (settingsOpen && connected) {
      if (running) {
        running = false;
        ws.send(JSON.stringify({ cmd: 'stop' }));
        var btnRun = document.getElementById('btn');
        btnRun.textContent = 'Start';
        btnRun.className   = 'hbtn';
      }
      ws.send(JSON.stringify({ cmd: 'get_settings' }));
    }
  };

  function getChannelMask() {
    var mask = 0;
    for (var i = 0; i < 4; i++) {
      if (document.getElementById('s_ch' + i).checked) mask |= (1 << i);
    }
    return mask;
  }

  function rebuildRefSelect(mask, curRef) {
    var sel = document.getElementById('s_ref');
    sel.innerHTML = '';
    for (var i = 0; i < 4; i++) {
      if (!(mask & (1 << i))) continue;
      var opt = document.createElement('option');
      opt.value = i;
      opt.textContent = 'Ch ' + (i + 1);
      sel.appendChild(opt);
    }
    sel.value = curRef;
  }

  window.onChannelChange = function () {
    var mask = getChannelMask();
    var curRef = parseInt(document.getElementById('s_ref').value, 10);
    rebuildRefSelect(mask, curRef);
    var warn = document.getElementById('s_ref_warn');
    if (mask !== 0 && !(mask & (1 << curRef))) {
      document.getElementById('s_ref').value = '';
      warn.style.display = '';
    } else {
      warn.style.display = 'none';
    }
  };

  function populateSettings(d) {
    var mask  = d.channel_mask  !== undefined ? d.channel_mask  : 0x0F;
    var refCh = d.reference_channel !== undefined ? d.reference_channel : 0;
    channelMask = mask;
    cylCount = 0;
    for (var i = 0; i < 4; i++) {
      document.getElementById('s_ch' + i).checked = !!(mask & (1 << i));
      if (mask & (1 << i)) cylCount++;
    }
    rebuildRefSelect(mask, refCh);
    document.getElementById('s_ref_warn').style.display = 'none';
    document.getElementById('s_damp').value     = d.damping;
    document.getElementById('s_rdamp').value    = d.rpm_damping;
    document.getElementById('s_interval').value = d.update_interval_ms;
    document.getElementById('s_ssid').value     = d.ap_ssid;
    document.getElementById('s_pw').value       = d.ap_password;
    buildWaveControls();
  }

  function showSettingsMsg(text, cls) {
    var el = document.getElementById('s_msg');
    el.textContent = text;
    el.className   = cls;
    setTimeout(function () { el.textContent = ''; el.className = ''; }, 3000);
  }

  window.saveSettings = function () {
    if (!connected) return;
    var mask  = getChannelMask();
    var refCh = parseInt(document.getElementById('s_ref').value, 10);
    if (mask === 0) { showSettingsMsg('Select at least one channel', 'err'); return; }
    if (isNaN(refCh) || !(mask & (1 << refCh))) {
      showSettingsMsg('Select a reference channel', 'err');
      document.getElementById('s_ref_warn').style.display = '';
      return;
    }
    document.getElementById('s_ref_warn').style.display = 'none';
    channelMask = mask;
    cylCount = 0;
    for (var i = 0; i < 4; i++) if (mask & (1 << i)) cylCount++;
    settingsSaved = true;
    ws.send(JSON.stringify({
      cmd:               'set_settings',
      channel_mask:       mask,
      reference_channel:  refCh,
      damping:            parseInt(document.getElementById('s_damp').value,     10),
      rpm_damping:        parseInt(document.getElementById('s_rdamp').value,    10),
      update_interval_ms: parseInt(document.getElementById('s_interval').value, 10),
      ap_ssid:            document.getElementById('s_ssid').value,
      ap_password:        document.getElementById('s_pw').value,
    }));
  };

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  window.setView = function (mode) {
    viewMode = mode;
    showView();
  };

  window.toggleRun = function () {
    if (!connected) return;
    if (running && plot) togglePlot();
    running = !running;
    ws.send(JSON.stringify({ cmd: running ? 'start' : 'stop' }));
    var btn = document.getElementById('btn');
    btn.textContent = running ? 'Stop' : 'Start';
    btn.className   = 'hbtn' + (running ? ' running' : '');
  };

  window.togglePlot = function () {
    if (!connected || !running) return;
    plot = !plot;
    if (plot) {
      waveChs = [[], [], [], []];
      plotFrozen = false;
      viewOffset = 0;
      updateScrollSlider();
    } else {
      plotFrozen = true;
    }
    ws.send(JSON.stringify({ cmd: 'wave', enabled: plot }));
    var btn = document.getElementById('btn_usb');
    btn.textContent = plot ? 'Stop Plot' : 'Start Plot';
    btn.className   = 'hbtn' + (plot ? ' running' : '');
  };

  buildWaveControls();
  startWaveRender();
  connect();
}());
