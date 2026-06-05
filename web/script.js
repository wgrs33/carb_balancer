(function () {
  // ---------------------------------------------------------------------------
  // localStorage helpers
  // ---------------------------------------------------------------------------
  function loadSetting(key, def) {
    var v = localStorage.getItem(key);
    return v !== null ? JSON.parse(v) : def;
  }
  function saveSetting(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  var ws, running = false, connected = false, plot = false, plotFrozen = false;
  var viewMode = 'gauge';
  var settingsOpen = false;
  var lastData = null;
  var pendingGaugeData = null;  // set by onmessage, consumed by RAF tick

  var channelMask = loadSetting('channel_mask', 0x0F);
  var refChannel  = loadSetting('reference_channel', 0);  // channel index 0-3
  var ref         = 0;  // index within active cylinders array — set by update()
  var cylCount    = 0;
  var emaAlpha    = 1 / (1 + loadSetting('damping', 8));

  (function initCylCount() {
    for (var i = 0; i < 4; i++) if (channelMask & (1 << i)) cylCount++;
  }());

  var emaKpa   = [null, null, null, null];
  var visibleChs = [true, true, true, true];
  var viewPts    = window.matchMedia('(max-width: 520px)').matches ? 100 : 400;
  var viewOffset = 0;
  var waveSpan   = 200;

  var WAVE_MAX  = 1200;
  var waveChs   = [[], [], [], []];
  var waveRaf   = null;
  var CH_COLORS = ['#4caf50', '#42a5f5', '#ffc107', '#ef5350'];

  // ---------------------------------------------------------------------------
  // Signal processing
  // ---------------------------------------------------------------------------

  // MPX4250AP (VOUT=VS×(P×0.004−0.04)) + 12kΩ/20kΩ divider (ratio 5/8) + ADS1115 GAIN_ONE
  // P = raw × (LSB / (VS × ratio × 0.004)) + 10  →  raw × 0.01 + 10
  function adcToKpa(raw) {
    return raw * 0.01 + 10;
  }

  function processWave(msg) {
    var chs = msg.chs || [];

    // Update EMA for each active channel using the batch average
    for (var c = 0; c < 4; c++) {
      if (!chs[c] || !chs[c].length) continue;
      var batchAvg = 0;
      for (var i = 0; i < chs[c].length; i++) batchAvg += adcToKpa(chs[c][i]);
      batchAvg /= chs[c].length;
      emaKpa[c] = (emaKpa[c] === null) ? batchAvg : emaAlpha * batchAvg + (1 - emaAlpha) * emaKpa[c];
    }

    var refKpa = emaKpa[refChannel] !== null ? emaKpa[refChannel] : 0;
    var cylinders = [];
    var refIdx = 0, idx = 0;
    for (var c = 0; c < 4; c++) {
      if (!(channelMask & (1 << c))) continue;
      if (c === refChannel) refIdx = idx;
      cylinders.push({
        kpa:       emaKpa[c] !== null ? emaKpa[c] : 0,
        delta_kpa: emaKpa[c] !== null ? emaKpa[c] - refKpa : 0,
      });
      idx++;
    }

    if (cylinders.length) pendingGaugeData = { rpm: 0, ref: refIdx, cylinders: cylinders };
    if (plot) appendWave(msg);
  }

  // ---------------------------------------------------------------------------
  // Wave buffer
  // ---------------------------------------------------------------------------

  function appendWave(msg) {
    var t0 = msg.t0 || 0, dt = msg.dt || 5000, chs = msg.chs || [];
    for (var c = 0; c < chs.length && c < 4; c++) {
      if (!chs[c]) continue;
      for (var i = 0; i < chs[c].length; i++)
        waveChs[c].push({ t: t0 + i * dt, v: adcToKpa(chs[c][i]) });
      if (waveChs[c].length > WAVE_MAX)
        waveChs[c] = waveChs[c].slice(waveChs[c].length - WAVE_MAX);
    }
  }

  function maxDataLen() {
    var n = 0;
    for (var c = 0; c < cylCount; c++) n = Math.max(n, waveChs[c].length);
    return n;
  }

  function updateScrollSlider() {
    var maxOff = Math.max(0, maxDataLen() - viewPts);
    var row = document.getElementById('wave-scroll-row');
    var sl  = document.getElementById('wave-scroll');
    if (maxOff > 0) {
      sl.max = maxOff;
      viewOffset = Math.min(viewOffset, maxOff);
      sl.value   = maxOff - viewOffset;
      row.style.display = '';
    } else {
      viewOffset = 0;
      row.style.display = 'none';
    }
  }

  window.onWaveZoom = function (val) {
    viewPts = parseInt(val);
    document.getElementById('wave-zoom-val').textContent = val;
    updateScrollSlider();
  };

  window.onWaveSpan = function (val) {
    waveSpan = parseInt(val);
    document.getElementById('wave-span-val').textContent = val;
  };

  window.onWaveScroll = function (val) {
    var sl = document.getElementById('wave-scroll');
    viewOffset = parseInt(sl.max) - parseInt(val);
  };

  // ---------------------------------------------------------------------------
  // Wave canvas
  // ---------------------------------------------------------------------------

  function niceStep(rough) {
    var p = Math.pow(10, Math.floor(Math.log10(rough || 1)));
    var f = rough / p;
    return f < 1.5 ? p : f < 3.5 ? 2 * p : f < 7.5 ? 5 * p : 10 * p;
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
    var center = isFinite(yMin) ? (yMin + yMax) / 2 : 70;
    yMin = center - waveSpan / 2;
    yMax = center + waveSpan / 2;

    function tx(off) { return ml + off / viewPts * pw; }
    function ty(v)   { return mt + (1 - (v - yMin) / (yMax - yMin)) * ph; }

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

    for (var c = 0; c < cylCount; c++) {
      var lx = ml + 6 + c * 58;
      ctx.fillStyle = CH_COLORS[c]; ctx.fillRect(lx, mt + 2, 12, 2);
      ctx.fillStyle = '#999'; ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText('Cyl ' + (c + 1), lx + 15, mt + 6);
    }

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
    function tick() {
      if (pendingGaugeData) { update(pendingGaugeData); pendingGaugeData = null; }
      updateScrollSlider();
      drawWave();
      waveRaf = requestAnimationFrame(tick);
    }
    waveRaf = requestAnimationFrame(tick);
  }

  function showView() {
    var n = document.getElementById('grid').children.length;
    if (n > 0) { buildGrid(n); if (lastData) update(lastData); }
  }

  // ---------------------------------------------------------------------------
  // Gauge
  // ---------------------------------------------------------------------------

  var G = { min: 0, max: 140, cx: 130, cy: 140, r: 90, sw: 14 };

  function cylColor(absDelta, isRef) {
    if (isRef || absDelta < 5)  return '#4caf50';
    if (absDelta < 10)          return '#ffc107';
    return '#ef5350';
  }

  function makeSvg(kpa, color) {
    var cx = G.cx, cy = G.cy, r = G.r, sw = G.sw;
    var lx = cx - r, rx = cx + r;
    var f  = Math.min(0.9999, Math.max(0.0001, (kpa - G.min) / (G.max - G.min)));
    var a  = Math.PI * (1 - f);
    var ex = (cx + r * Math.cos(a)).toFixed(1);
    var ey = (cy - r * Math.sin(a)).toFixed(1);
    var bgArc = 'M ' + lx + ' ' + cy + ' A ' + r + ' ' + r + ' 0 0 1 ' + rx + ' ' + cy;
    var fgArc = 'M ' + lx + ' ' + cy + ' A ' + r + ' ' + r + ' 0 0 1 ' + ex + ' ' + ey;
    var s = '<svg viewBox="0 0 260 150" width="100%" xmlns="http://www.w3.org/2000/svg">';
    s += '<path d="' + bgArc + '" stroke="#282828" stroke-width="' + sw + '" fill="none" stroke-linecap="round"/>';
    s += '<path d="' + fgArc + '" stroke="' + color + '" stroke-width="' + sw + '" fill="none" stroke-linecap="round"/>';
    var rTi = r + sw / 2 + 3, rTo = rTi + 8, rLb = rTo + 12;
    [0, 20, 40, 60, 80, 100, 120, 140].forEach(function (v) {
      var ta = Math.PI * (1 - v / G.max), ca = Math.cos(ta), sa = Math.sin(ta);
      var x1 = (cx + rTi * ca).toFixed(1), y1 = (cy - rTi * sa).toFixed(1);
      var x2 = (cx + rTo * ca).toFixed(1), y2 = (cy - rTo * sa).toFixed(1);
      var lbx = (cx + rLb * ca).toFixed(1), lby = (cy - rLb * sa + 3.5).toFixed(1);
      s += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="#484848" stroke-width="1.5"/>';
      s += '<text x="' + lbx + '" y="' + lby + '" text-anchor="middle" fill="#555" font-size="9" font-family="sans-serif">' + v + '</text>';
    });
    s += '<text x="' + cx + '" y="' + (cy - 22) + '" text-anchor="middle" fill="#eee" font-size="22" font-weight="700" font-family="sans-serif">' + kpa.toFixed(1) + '</text>';
    s += '<text x="' + cx + '" y="' + (cy - 6)  + '" text-anchor="middle" fill="#555" font-size="9"  font-family="sans-serif">kPa</text>';
    s += '</svg>';
    return s;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  function updateStatus(cyls) {
    var el = document.getElementById('status');
    if (!running) { el.textContent = '--'; el.className = ''; return; }
    var maxDelta = 0;
    cyls.forEach(function (c, i) {
      if (i !== ref) maxDelta = Math.max(maxDelta, Math.abs(c.delta_kpa));
    });
    if (maxDelta < 5)       { el.textContent = 'Synchronized';        el.className = 'sync';   }
    else if (maxDelta < 10) { el.textContent = 'Almost Synchronized'; el.className = 'almost'; }
    else                    { el.textContent = 'Desynchronized';       el.className = 'desync'; }
  }

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
        dt.textContent = dText; dt.className = 'gauge-delta ' + dCls;
      } else {
        card.className = 'cyl' + (isRef ? ' ref' : '');
        card.querySelector('.cyl-kpa').textContent = c.kpa.toFixed(1);
        var dt = card.querySelector('.cyl-delta');
        dt.textContent = dText; dt.className = 'cyl-delta ' + dCls;
      }
    });
  }

  function buildWaveControls() {
    document.getElementById('wave-zoom').value = viewPts;
    document.getElementById('wave-zoom-val').textContent = viewPts;
    var ctrl = document.getElementById('wave-ch-btns');
    ctrl.innerHTML = '';
    for (var c = 0; c < cylCount; c++) {
      (function (ch) {
        var btn = document.createElement('button');
        btn.textContent = 'Cyl ' + (ch + 1);
        btn.style.color = CH_COLORS[ch];
        btn.style.borderColor = CH_COLORS[ch];
        btn.className = visibleChs[ch] ? '' : 'off';
        btn.onclick = function () {
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
        ? '<div class="gauge-card"><div class="gauge-label">Cyl ' + (i + 1) + '</div><div class="gauge-svg"></div><div class="gauge-delta zero">---</div></div>'
        : '<div class="cyl"><div class="cyl-label">Cyl ' + (i + 1) + '</div><div class="cyl-kpa">--.-</div><div class="cyl-unit">kPa</div><div class="cyl-delta zero">---</div></div>';
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

  function connect() {
    ws = new WebSocket('ws://' + location.host + '/ws');

    ws.onopen = function () {
      connected = true;
      document.getElementById('dot').className = 'ok';
      document.getElementById('btn').disabled     = false;
      document.getElementById('btn_usb').disabled = false;

      // Apply session settings from localStorage
      channelMask = loadSetting('channel_mask', 0x0F);
      refChannel  = loadSetting('reference_channel', 0);
      emaAlpha    = 1 / (1 + loadSetting('damping', 8));
      cylCount = 0;
      for (var i = 0; i < 4; i++) if (channelMask & (1 << i)) cylCount++;
      buildGrid(cylCount);
      buildWaveControls();

      ws.send(JSON.stringify({
        cmd:               'set_session',
        channel_mask:       channelMask,
        reference_channel:  refChannel,
        update_interval_ms: loadSetting('update_interval_ms', 50),
      }));
      ws.send(JSON.stringify({ cmd: 'get_wifi' }));
    };

    ws.onclose = function () {
      connected = false;
      running   = false;
      emaKpa    = [null, null, null, null];
      document.getElementById('dot').className     = '';
      document.getElementById('btn').disabled      = true;
      document.getElementById('btn_usb').disabled  = true;
      document.getElementById('btn').textContent   = 'Start';
      document.getElementById('btn').className     = 'hbtn';
      document.getElementById('status').textContent = '--';
      document.getElementById('status').className   = '';
      setTimeout(connect, 2000);
    };

    ws.onmessage = function (e) {
      var d;
      try { d = JSON.parse(e.data); } catch (_) { return; }
      if (d.type === 'wave')       { processWave(d); return; }
      if (d.type === 'wifi')       { populateWifiFields(d); return; }
      if (d.type === 'wifi_saved') { showSettingsMsg('Saved', 'ok'); return; }
    };
  }

  // ---------------------------------------------------------------------------
  // Settings panel
  // ---------------------------------------------------------------------------

  function populateSettings() {
    var mask  = loadSetting('channel_mask', 0x0F);
    var refCh = loadSetting('reference_channel', 0);
    for (var i = 0; i < 4; i++)
      document.getElementById('s_ch' + i).checked = !!(mask & (1 << i));
    rebuildRefSelect(mask, refCh);
    document.getElementById('s_ref_warn').style.display = 'none';
    document.getElementById('s_damp').value     = loadSetting('damping', 8);
    document.getElementById('s_rdamp').value    = loadSetting('rpm_damping', 8);
    document.getElementById('s_interval').value = loadSetting('update_interval_ms', 50);
  }

  function populateWifiFields(d) {
    document.getElementById('s_ssid').value = d.ap_ssid     || '';
    document.getElementById('s_pw').value   = d.ap_password || '';
  }

  function getChannelMask() {
    var mask = 0;
    for (var i = 0; i < 4; i++)
      if (document.getElementById('s_ch' + i).checked) mask |= (1 << i);
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
    var mask   = getChannelMask();
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

  function showSettingsMsg(text, cls) {
    var el = document.getElementById('s_msg');
    el.textContent = text;
    el.className   = cls;
    setTimeout(function () { el.textContent = ''; el.className = ''; }, 3000);
  }

  window.toggleSettings = function () {
    settingsOpen = !settingsOpen;
    document.getElementById('settings-panel').style.display = settingsOpen ? 'block' : 'none';
    document.getElementById('status').style.display         = settingsOpen ? 'none' : '';
    document.getElementById('grid').style.display           = settingsOpen ? 'none' : '';
    document.getElementById('wave-wrap').style.display      = settingsOpen ? 'none' : '';
    var btn = document.getElementById('btn_settings');
    btn.textContent = settingsOpen ? '✕' : '⚙';
    btn.className   = 'hbtn' + (settingsOpen ? ' active' : '');
    if (settingsOpen) {
      if (running) {
        if (plot) togglePlot();
        running = false;
        ws.send(JSON.stringify({ cmd: 'stop' }));
        var btnRun = document.getElementById('btn');
        btnRun.textContent = 'Start';
        btnRun.className   = 'hbtn';
      }
      populateSettings();
      if (connected) ws.send(JSON.stringify({ cmd: 'get_wifi' }));
    }
  };

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

    var intervalMs = parseInt(document.getElementById('s_interval').value, 10);
    var damping    = parseInt(document.getElementById('s_damp').value, 10);
    var rpmDamping = parseInt(document.getElementById('s_rdamp').value, 10);

    // Persist session settings to localStorage
    saveSetting('channel_mask', mask);
    saveSetting('reference_channel', refCh);
    saveSetting('update_interval_ms', intervalMs);
    saveSetting('damping', damping);
    saveSetting('rpm_damping', rpmDamping);

    // Update in-memory state
    channelMask = mask;
    refChannel  = refCh;
    emaAlpha    = 1 / (1 + damping);
    emaKpa      = [null, null, null, null];
    cylCount    = 0;
    for (var i = 0; i < 4; i++) if (mask & (1 << i)) cylCount++;

    // Send session settings to firmware (stops ADC server-side before applying)
    ws.send(JSON.stringify({
      cmd:               'set_session',
      channel_mask:       mask,
      reference_channel:  refCh,
      update_interval_ms: intervalMs,
    }));

    // Send WiFi settings to firmware (persisted to NVS)
    ws.send(JSON.stringify({
      cmd:         'set_wifi',
      ap_ssid:     document.getElementById('s_ssid').value,
      ap_password: document.getElementById('s_pw').value,
    }));
  };

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------

  window.setView = function (mode) { viewMode = mode; showView(); };

  window.toggleRun = function () {
    if (!connected) return;
    if (running && plot) togglePlot();
    running = !running;
    ws.send(JSON.stringify({ cmd: running ? 'start' : 'stop' }));
    if (!running) emaKpa = [null, null, null, null];
    var btn = document.getElementById('btn');
    btn.textContent = running ? 'Stop' : 'Start';
    btn.className   = 'hbtn' + (running ? ' running' : '');
  };

  window.togglePlot = function () {
    if (!connected || !running) return;
    plot = !plot;
    if (plot) {
      waveChs    = [[], [], [], []];
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