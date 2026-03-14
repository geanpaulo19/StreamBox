/* ============================================================
   StreamBox — app.js
   Source  : iptv-org  (channels.json + streams.json + countries.json)
   Coverage: All countries worldwide, filtered client-side
   ============================================================ */
'use strict';

const EP = {
  channels:  'https://iptv-org.github.io/api/channels.json',
  streams:   'https://iptv-org.github.io/api/streams.json',
  countries: 'https://iptv-org.github.io/api/countries.json',
};

/* ─── State ───────────────────────────────────────────────────── */
let allChannels    = [];   // full merged list (all countries)
let filteredChs    = [];   // current view after country + cat + search
let countryMap     = {};   // code → { name, flag }
let currentChannel = null;
let currentCat     = 'all';
let currentCountry = 'all';
let hls            = null;
let retryTarget    = null;
let isMuted        = true;

/* ─── Virtual scroll state ────────────────────────────────────── */
const ITEM_H    = 54;   // px — must match min-height in CSS
const OVERSCAN  = 8;    // extra rows above/below viewport
let vsRenderedStart = 0;
let vsRenderedEnd   = 0;
let searchDebounce  = null;

/* ─── DOM ─────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

const video         = $('video-el');
const chList        = $('channel-list');
const searchInput   = $('search-input');
const sidebarSearchInput = $('sidebar-search-input');
const catTabs       = $('cat-tabs');
const chCount       = $('ch-count');
const channelTotal  = $('channel-total');
const idleScreen    = $('idle-screen');
const bufferOvl     = $('buffer-overlay');
const errorOvl      = $('error-overlay');
const errorMsg      = $('error-msg');
const nowBadge      = $('now-badge');
const nowName       = $('now-name');
const nowLogo       = $('now-logo');
const infoThumb     = $('info-thumb');
const infoName      = $('info-name');
const infoSub       = $('info-sub');
const sidebar       = $('sidebar');
const sidebarBg     = $('sidebar-overlay');
const toast         = $('toast');
const countryDropdown = $('country-dropdown');
const selectedFlag  = $('selected-flag');
const selectedLabel = $('selected-label');
const sugList       = $('suggestions-list');
const sugLabel      = $('sug-label');
const loadBar       = document.createElement('div');

/* ─── Insert load bar just below sidebar header ─────────────────── */
loadBar.id = 'load-bar';
$('channel-list').before(loadBar);

/* ============================================================
   CATEGORY MAP
   ============================================================ */
const CAT_MAP = {
  general:'general', news:'news', entertainment:'entertainment',
  sports:'sports', kids:'kids', music:'entertainment', movies:'entertainment',
  documentary:'entertainment', lifestyle:'entertainment', science:'entertainment',
  travel:'entertainment', auto:'entertainment', cooking:'entertainment',
  family:'kids', animation:'kids', religious:'general', legislative:'news',
  business:'news', weather:'news', outdoor:'entertainment', shop:'general',
  series:'entertainment', culture:'entertainment', comedy:'entertainment',
  classic:'entertainment', adult:'entertainment',
};

const TAB_ORDER = ['general','news','entertainment','sports','kids'];
const TAB_LABEL = {
  all:'All', general:'General', news:'News',
  entertainment:'Entertainment', sports:'Sports', kids:'Kids',
};

function mapCat(cats = []) {
  for (const c of cats) {
    const k = CAT_MAP[(c||'').toLowerCase().trim()];
    if (k) return k;
  }
  return 'general';
}

/* ============================================================
   M3U PARSER  (unused for global load, kept for future)
   ============================================================ */
function parseM3U(text) {
  const lines = text.split('\n').map(l=>l.trim()).filter(Boolean);
  const out=[], attr=(l,k)=>{const m=l.match(new RegExp(String.raw`${k}="([^"]*)"`,'i'));return m?m[1].trim():'';};
  let meta=null;
  for(const line of lines){
    if(line.startsWith('#EXTINF')){
      const c=line.lastIndexOf(',');
      meta={id:attr(line,'tvg-id'),name:attr(line,'tvg-name')||(c>=0?line.slice(c+1).trim():''),logo:attr(line,'tvg-logo')||null,group:attr(line,'group-title')||''};
    } else if(meta&&!line.startsWith('#')&&line.startsWith('http')){
      if(!line.endsWith('.mpd'))out.push({id:meta.id||toSlug(meta.name),name:meta.name||'Unknown',logo:meta.logo,cat:mapCat([meta.group]),url:line,country:'',flag:''});
      meta=null;
    }
  }
  return out;
}

function toSlug(s){return s.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');}

/* ============================================================
   SKELETON LOADER
   ============================================================ */
function showSkeletons(n=16){
  chList.innerHTML=Array.from({length:n},(_,i)=>`
    <li class="skel-item" style="animation-delay:${i*18}ms">
      <div class="skel-logo"></div>
      <div class="skel-text">
        <div class="skel-line wide"></div>
        <div class="skel-line narrow"></div>
      </div>
    </li>`).join('');
}

/* ============================================================
   DATA LOADING
   Fires channels.json, streams.json, and countries.json together.
   No country filter — loads everything, filters client-side.
   ============================================================ */
async function loadAll() {
  showSkeletons();
  loadBar.classList.remove('done');
  chCount.textContent = 'Fetching channels…';

  const [chRes, stRes, ctRes] = await Promise.allSettled([
    fetch(EP.channels),
    fetch(EP.streams),
    fetch(EP.countries),
  ]);

  /* ── Countries lookup ─────────────────────────────────────── */
  if (ctRes.status==='fulfilled' && ctRes.value.ok) {
    try {
      const countries = await ctRes.value.json();
      for (const c of countries) {
        countryMap[c.code] = { name: c.name, flag: c.flag || flagEmoji(c.code) };
      }
    } catch(e){ console.warn('[StreamBox] countries.json parse error', e); }
  }

  /* ── Build stream map: channel-id → best URL ─────────────── */
  const streamMap = {};
  if (stRes.status==='fulfilled' && stRes.value.ok) {
    try {
      const streams = await stRes.value.json();
      for (const s of streams) {
        if (!s.channel || !s.url || s.url.endsWith('.mpd')) continue;
        const prev = streamMap[s.channel];
        const isOnline = s.status === 'online';
        if (!prev || (isOnline && prev.status !== 'online')) {
          streamMap[s.channel] = { url: s.url, status: s.status || '' };
        }
      }
      console.info(`[StreamBox] ${Object.keys(streamMap).length} streams indexed`);
    } catch(e){ console.warn('[StreamBox] streams.json error', e); }
  }

  /* ── Map channels ─────────────────────────────────────────── */
  if (chRes.status==='fulfilled' && chRes.value.ok) {
    try {
      const channels = await chRes.value.json();
      const mapped = [];
      for (const ch of channels) {
        if (ch.closed) continue;
        const st = streamMap[ch.id];
        if (!st) continue;

        const code = (ch.country || '').toUpperCase();
        const ctry = countryMap[code] || { name: code || 'Unknown', flag: flagEmoji(code) };

        mapped.push({
          id:      ch.id,
          name:    ch.name,
          logo:    ch.logo || null,
          cat:     mapCat(ch.categories || []),
          url:     st.url,
          status:  st.status,
          country: code,
          ctname:  ctry.name,
          flag:    ctry.flag,
        });
      }

      allChannels = mapped.sort((a,b) => {
        if (a.status==='online' && b.status!=='online') return -1;
        if (b.status==='online' && a.status!=='online') return  1;
        return a.name.localeCompare(b.name);
      });

      console.info(`[StreamBox] ${allChannels.length} channels loaded`);
    } catch(e){ console.warn('[StreamBox] channels.json error', e); }
  }

  if (!allChannels.length) {
    chList.innerHTML=`<li style="padding:32px 14px;text-align:center;color:var(--txt-3);font-size:.8rem;line-height:1.9">Could not load channels.<br>Check your connection and refresh.</li>`;
    chCount.textContent='No channels loaded';
    showToast('⚠ Could not load channel list');
    loadBar.classList.add('done');
    return;
  }

  buildSearchIndex();
  buildCountryDropdown();
  syncCatTabs();
  applyFilters();
  renderSuggestions();
  channelTotal.innerHTML = `<span>${allChannels.length.toLocaleString()}</span> channels`;
  loadBar.classList.add('done');
}

/* ============================================================
   COUNTRY DROPDOWN — custom, scrollable, no native <select>
   ============================================================ */
function buildCountryDropdown() {
  const seen = new Map();
  for (const ch of allChannels) {
    if (!seen.has(ch.country)) seen.set(ch.country, { name: ch.ctname, flag: ch.flag, count: 0 });
    seen.get(ch.country).count++;
  }
  const sorted = [...seen.entries()].sort((a,b) => a[1].name.localeCompare(b[1].name));

  const list = $('country-list');
  list.innerHTML = '';

  /* "All Countries" option */
  const allOpt = makeOption('all', '🌐', 'All Countries', null);
  allOpt.classList.add('selected');
  list.appendChild(allOpt);

  for (const [code, info] of sorted) {
    list.appendChild(makeOption(code, info.flag, `${info.name} (${info.count})`, null));
  }
}

function makeOption(value, flag, label) {
  const li = document.createElement('li');
  li.className = 'custom-select-option';
  li.setAttribute('role', 'option');
  li.dataset.value = value;
  li.innerHTML = `<span class="opt-flag">${flag}</span><span class="opt-label">${esc(label)}</span>`;
  li.addEventListener('click', e => { e.stopPropagation(); selectCountry(value, flag, label.split(' (')[0]); });
  return li;
}

function selectCountry(value, flag, name) {
  currentCountry = value;

  /* Update trigger display */
  selectedFlag.textContent  = flag;
  selectedLabel.textContent = value === 'all' ? 'All Countries' : name;

  /* Mark selected option */
  document.querySelectorAll('#country-list .custom-select-option').forEach(el => {
    el.classList.toggle('selected', el.dataset.value === value);
  });

  closeDropdown();

  /* Reset category */
  currentCat = 'all';
  document.querySelectorAll('.cat-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.cat === 'all');
  });

  syncCatTabs();
  applyFilters();
  renderSuggestions();
}

/* Toggle open/close */
function openDropdown() {
  countryDropdown.setAttribute('aria-expanded', 'true');
}
function closeDropdown() {
  countryDropdown.setAttribute('aria-expanded', 'false');
}

countryDropdown.addEventListener('click', e => {
  const isOpen = countryDropdown.getAttribute('aria-expanded') === 'true';
  isOpen ? closeDropdown() : openDropdown();
  e.stopPropagation();
});

countryDropdown.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDropdown(); }
  if (e.key === 'Escape') closeDropdown();
});

/* Close when clicking outside */
document.addEventListener('click', e => {
  if (!countryDropdown.contains(e.target)) closeDropdown();
});

/* ============================================================
   CATEGORY TABS — dynamic, reflects active country's categories
   ============================================================ */
function syncCatTabs() {
  /* Which channels are in scope for the current country? */
  const scope  = currentCountry === 'all'
    ? allChannels
    : allChannels.filter(c => c.country === currentCountry);

  const present = new Set(scope.map(c => c.cat));

  /* Remove previously injected dynamic tabs */
  document.querySelectorAll('.cat-tab[data-dyn]').forEach(t=>t.remove());

  for (const cat of TAB_ORDER) {
    if (!present.has(cat)) continue;
    if (document.querySelector(`.cat-tab[data-cat="${cat}"]`)) continue;
    const btn = document.createElement('button');
    btn.className   = 'cat-tab';
    btn.dataset.cat = cat;
    btn.dataset.dyn = '1';
    btn.textContent = TAB_LABEL[cat];
    catTabs.appendChild(btn);
  }
}

/* ============================================================
   VIRTUAL SCROLL
   Structure kept stable across scrolls:
     [topSpacer] [visible rows…] [bottomSpacer]
   Only the middle rows are swapped — spacers never move.
   ============================================================ */
let vsTopSpacer    = null;
let vsBottomSpacer = null;
let vsRafPending   = false;

function renderList(channels) {
  chList.removeEventListener('scroll', onListScroll);

  if (!channels.length) {
    chList.innerHTML = `<li style="padding:32px 14px;text-align:center;color:var(--txt-3);font-size:.8rem;line-height:1.8">No channels found.<br>Try a different search, country, or category.</li>`;
    vsTopSpacer = vsBottomSpacer = null;
    vsRenderedStart = vsRenderedEnd = 0;
    return;
  }

  /* Build stable skeleton: top-spacer · bottom-spacer */
  chList.innerHTML = '';
  vsTopSpacer    = document.createElement('li');
  vsBottomSpacer = document.createElement('li');
  const sp = 'display:block;pointer-events:none;flex-shrink:0;';
  vsTopSpacer.style.cssText    = sp;
  vsBottomSpacer.style.cssText = sp;
  chList.appendChild(vsTopSpacer);
  chList.appendChild(vsBottomSpacer);

  vsRenderedStart = vsRenderedEnd = 0;
  chList.scrollTop = 0;

  chList.addEventListener('scroll', onListScroll, { passive: true });
  paintWindow(channels, 0);
}

function paintWindow(channels, scrollTop) {
  if (!vsTopSpacer) return;

  const viewH = chList.clientHeight || 600;
  const total = channels.length;
  const start = Math.max(0, Math.floor(scrollTop / ITEM_H) - OVERSCAN);
  const end   = Math.min(total, Math.ceil((scrollTop + viewH) / ITEM_H) + OVERSCAN);

  /* Skip repaint if window is identical */
  if (start === vsRenderedStart && end === vsRenderedEnd) return;
  vsRenderedStart = start;
  vsRenderedEnd   = end;

  /* Update spacer heights */
  vsTopSpacer.style.height    = (start * ITEM_H) + 'px';
  vsBottomSpacer.style.height = ((total - end) * ITEM_H) + 'px';

  /* Build new rows off-DOM */
  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    frag.appendChild(buildItem(channels[i], i));
  }

  /* Remove old rows (everything between the two spacers) */
  while (vsTopSpacer.nextSibling && vsTopSpacer.nextSibling !== vsBottomSpacer) {
    chList.removeChild(vsTopSpacer.nextSibling);
  }

  /* Insert new rows before bottom spacer */
  chList.insertBefore(frag, vsBottomSpacer);
}

function onListScroll() {
  if (vsRafPending) return;
  vsRafPending = true;
  requestAnimationFrame(() => {
    vsRafPending = false;
    paintWindow(filteredChs, chList.scrollTop);
  });
}

function buildItem(ch, i) {
  const active = currentChannel?.id === ch.id;
  const li = document.createElement('li');
  li.className = `channel-item${active ? ' active' : ''}`;
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', String(active));
  li.dataset.id = ch.id;

  /* Logo */
  const wrap = document.createElement('div');
  wrap.className = 'ch-logo-wrap';
  wrap.appendChild(makeLogoEl(ch.logo, ch.name, 'ch-letter'));

  /* Text — use textContent (no HTML parsing) */
  const info = document.createElement('div');
  info.className = 'ch-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'ch-name';
  nameEl.textContent = ch.name;

  const meta = document.createElement('div');
  meta.className = 'ch-meta';
  meta.innerHTML = `<span class="ch-flag">${ch.flag || ''}</span>`;
  meta.appendChild(document.createTextNode(`${ch.ctname || ch.country} · ${TAB_LABEL[ch.cat] || ch.cat}`));

  info.append(nameEl, meta);

  const dot = document.createElement('div');
  dot.className = 'ch-now-badge';

  li.append(wrap, info, dot);
  li.addEventListener('click',   () => switchTo(ch));
  li.addEventListener('keydown', e  => { if (e.key === 'Enter') switchTo(ch); });
  return li;
}

/* ============================================================
   ELEMENT HELPERS
   ============================================================ */
/* Cache of logo URLs that have previously 404'd — skip img for these */
const failedLogos = new Set();

function makeLogoEl(src, name, fallbackClass) {
  if (src && !failedLogos.has(src)) {
    const img = document.createElement('img');
    img.src    = src;
    img.alt    = name;
    img.width  = 38;
    img.height = 38;
    img.onerror = () => {
      failedLogos.add(src);
      img.replaceWith(makeLetterEl(name, fallbackClass));
    };
    return img;
  }
  return makeLetterEl(name, fallbackClass);
}
function makeLetterEl(name,cls){
  const s=document.createElement('span');
  s.className=cls; s.textContent=(name?.[0]??'?').toUpperCase();
  return s;
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

/* Convert ISO-3166-1 alpha-2 country code to flag emoji */
function flagEmoji(code=''){
  if(!code||code.length!==2) return '🏳';
  return [...code.toUpperCase()].map(c=>String.fromCodePoint(c.codePointAt(0)+127397)).join('');
}

/* ============================================================
   FILTERS — Country + Category + Search
   Pre-lowercased fields cached on each channel object so
   filter() never calls .toLowerCase() at query time.
   ============================================================ */
function buildSearchIndex() {
  for (const ch of allChannels) {
    ch._nameL  = ch.name.toLowerCase();
    ch._ctnameL = (ch.ctname || ch.country).toLowerCase();
  }
}

function applyFilters() {
  const q = searchInput.value.trim().toLowerCase();

  filteredChs = allChannels.filter(ch => {
    if (currentCountry !== 'all' && ch.country !== currentCountry) return false;
    if (currentCat     !== 'all' && ch.cat     !== currentCat)     return false;
    if (q && !ch._nameL.includes(q) && !ch._ctnameL.includes(q))  return false;
    return true;
  });

  renderList(filteredChs);

  const label   = currentCat === 'all' ? 'channels' : `${TAB_LABEL[currentCat] || currentCat} channels`;
  const ctLabel = currentCountry === 'all' ? 'Worldwide' : (countryMap[currentCountry]?.name || currentCountry);
  chCount.innerHTML = `<span>${filteredChs.length.toLocaleString()}</span> ${label} · ${esc(ctLabel)}`;
}

/* ============================================================
   SUGGESTIONS — O(n) reservoir sample, no full-array sort
   ============================================================ */
function reservoirSample(arr, k) {
  /* Fisher-Yates partial shuffle — stops after k picks */
  const result = [];
  const pool   = arr.slice(); // shallow copy to avoid mutating source
  const lim    = Math.min(k, pool.length);
  for (let i = 0; i < lim; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
    result.push(pool[i]);
  }
  return result;
}

function renderSuggestions() {
  if (!sugList) return;

  const pool = allChannels.filter(c =>
    (currentCountry === 'all' || c.country === currentCountry) &&
    c.id !== currentChannel?.id
  );

  /* Prefer online channels; sample up to 12 total */
  const online  = pool.filter(c => c.status === 'online');
  const offline = pool.filter(c => c.status !== 'online');
  const need    = 12;
  const fromOnline  = reservoirSample(online,  Math.min(need, online.length));
  const fromOffline = reservoirSample(offline, Math.max(0, need - fromOnline.length));
  const picks   = [...fromOnline, ...fromOffline];

  const flag   = currentCountry === 'all' ? '' : (countryMap[currentCountry]?.flag || '');
  const ctName = currentCountry === 'all' ? 'Worldwide' : (countryMap[currentCountry]?.name || currentCountry);
  sugLabel.textContent = currentCountry === 'all' ? 'Suggested Channels' : `${flag} ${ctName}`;

  /* Build with a fragment — single DOM insertion */
  const frag = document.createDocumentFragment();
  picks.forEach(ch => {
    const isOnline = ch.status === 'online';
    const li = document.createElement('li');
    li.className = 'sug-item';
    li.setAttribute('role', 'option');
    li.setAttribute('data-online', isOnline ? '1' : '0');

    const logoWrap = document.createElement('div');
    logoWrap.className = 'sug-logo';
    logoWrap.appendChild(makeLogoEl(ch.logo, ch.name, 'sug-letter'));
    const liveBadge = document.createElement('div');
    liveBadge.className = 'sug-live-badge';
    liveBadge.textContent = 'Live';
    logoWrap.appendChild(liveBadge);

    const body = document.createElement('div');
    body.className = 'sug-body';
    const nameEl = document.createElement('div');
    nameEl.className = 'sug-name';
    nameEl.textContent = ch.name;
    const catEl = document.createElement('div');
    catEl.className = 'sug-cat';
    catEl.textContent = TAB_LABEL[ch.cat] || ch.cat;
    body.append(nameEl, catEl);

    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('viewBox', '0 0 24 24');
    arrow.setAttribute('fill', 'none');
    arrow.setAttribute('stroke', 'currentColor');
    arrow.setAttribute('stroke-width', '2.5');
    arrow.setAttribute('stroke-linecap', 'round');
    arrow.setAttribute('stroke-linejoin', 'round');
    arrow.classList.add('sug-arrow');
    arrow.innerHTML = '<polyline points="9 18 15 12 9 6"/>';

    li.append(logoWrap, body, arrow);
    li.addEventListener('click', () => switchTo(ch));
    frag.appendChild(li);
  });

  sugList.innerHTML = '';
  sugList.appendChild(frag);
}

/* ── Shared search handler — debounced ────────────────────────── */
function handleSearch(val) {
  searchInput.value        = val;
  sidebarSearchInput.value = val;

  if (val.trim() && currentCountry !== 'all') {
    selectCountry('all', '🌐', 'All Countries');
  }

  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(applyFilters, 120);
}

searchInput.addEventListener('input',        () => handleSearch(searchInput.value));
sidebarSearchInput.addEventListener('input', () => handleSearch(sidebarSearchInput.value));

catTabs.addEventListener('click', e => {
  const tab = e.target.closest('.cat-tab');
  if (!tab) return;
  document.querySelectorAll('.cat-tab').forEach(t=>t.classList.remove('active'));
  tab.classList.add('active');
  currentCat = tab.dataset.cat;
  applyFilters();
});

/* ============================================================
   CORE — switchTo(ch)
   ============================================================ */
function switchTo(ch) {
  if (!ch?.url) { showToast('⚠ No stream URL for this channel'); return; }

  currentChannel = ch;
  retryTarget    = ch;

  /* Mark active by data-id — works regardless of virtual scroll window */
  document.querySelectorAll('.channel-item').forEach(el => {
    const isActive = el.dataset.id === ch.id;
    el.classList.toggle('active', isActive);
    el.setAttribute('aria-selected', String(isActive));
  });

  /* Scroll the list so the selected row is visible.
     With virtual scroll we can't use scrollIntoView on the element
     (it may not be in the DOM). Instead, jump by index offset. */
  const idx = filteredChs.findIndex(c => c.id === ch.id);
  if (idx !== -1) {
    const itemTop    = idx * ITEM_H;
    const itemBottom = itemTop + ITEM_H;
    const listTop    = chList.scrollTop;
    const listBottom = listTop + chList.clientHeight;
    if (itemTop < listTop) {
      chList.scrollTop = itemTop - 8;
    } else if (itemBottom > listBottom) {
      chList.scrollTop = itemBottom - chList.clientHeight + 8;
    }
  }

  idleScreen.classList.add('hidden');
  errorOvl.classList.remove('show');
  hideBadge();
  showBuf(true);
  updateInfoBar(ch);
  closeSidebar();

  video.muted = false;
  isMuted     = false;
  syncMuteBtn();

  if (Hls.isSupported()) {
    if (hls) {
      hls.detachMedia(); hls.loadSource(ch.url); hls.attachMedia(video);
    } else {
      hls = new Hls({
        enableWorker:true, lowLatencyMode:true,
        backBufferLength:60, maxBufferLength:30, maxMaxBufferLength:90,
      });
      hls.loadSource(ch.url); hls.attachMedia(video); bindHlsEvents();
    }
    video.play().catch(()=>{});
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src=ch.url; video.play().catch(()=>{});
  } else {
    showErr('HLS is not supported in this browser.'); return;
  }

  showToast(`▶ ${ch.name}`);
  renderSuggestions();
}

/* ── HLS.js events ──────────────────────────────────────────────── */
function bindHlsEvents() {
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    showBuf(false); showBadge(currentChannel); video.play().catch(()=>{});
  });
  hls.on(Hls.Events.ERROR, (_,d) => {
    if(!d.fatal) return;
    showBuf(false);
    if(d.type===Hls.ErrorTypes.NETWORK_ERROR)
      showErr('Stream offline or geo-blocked.\nTry a different channel.');
    else if(d.type===Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
    else showErr('Playback error. Channel may be temporarily down.');
  });
}

video.addEventListener('waiting', ()=>showBuf(true));
video.addEventListener('playing', ()=>showBuf(false));
video.addEventListener('canplay', ()=>showBuf(false));
video.addEventListener('stalled', ()=>showBuf(true));
video.addEventListener('error',   ()=>{ showBuf(false); if(currentChannel) showErr('Could not load stream.'); });

/* ============================================================
   NOW PLAYING BADGE — CSS animation auto-fades after 5s
   ============================================================ */
function showBadge(ch) {
  if (!ch) return;
  nowName.textContent = ch.name;
  nowLogo.innerHTML   = '';
  if (ch.logo) {
    const img=document.createElement('img');
    img.src=ch.logo; img.alt=ch.name;
    img.onerror=()=>{nowLogo.textContent=ch.name[0].toUpperCase();};
    nowLogo.appendChild(img);
  } else { nowLogo.textContent=ch.name[0].toUpperCase(); }

  /* Restart animation */
  nowBadge.classList.remove('visible');
  void nowBadge.offsetWidth;
  nowBadge.classList.add('visible');
}
function hideBadge(){ nowBadge.classList.remove('visible'); }

/* ============================================================
   UI HELPERS
   ============================================================ */
function showBuf(v){ bufferOvl.classList.toggle('show',v); }
function showErr(msg){ errorMsg.textContent=msg; errorOvl.classList.add('show'); }

function updateInfoBar(ch){
  /* ── Desktop info bar ─────────────────────────────────── */
  infoThumb.innerHTML='';
  if(ch.logo){
    const img=document.createElement('img');
    img.src=ch.logo; img.alt=ch.name;
    img.onerror=()=>{infoThumb.innerHTML=`<span class="no-logo">${ch.name[0].toUpperCase()}</span>`;};
    infoThumb.appendChild(img);
  } else {
    infoThumb.innerHTML=`<span class="no-logo">${ch.flag||ch.name[0].toUpperCase()}</span>`;
  }
  infoName.textContent=ch.name;
  infoName.classList.remove('idle');
  infoSub.textContent=`${ch.flag||''} ${ch.ctname||ch.country} · ${TAB_LABEL[ch.cat]||ch.cat} · Live`;

  /* ── Mobile now-playing strip ─────────────────────────── */
  const mobThumb=$('mob-info-thumb');
  const mobName=$('mob-info-name');
  const mobSub=$('mob-info-sub');
  if(mobThumb){
    mobThumb.innerHTML='';
    if(ch.logo){
      const img=document.createElement('img');
      img.src=ch.logo; img.alt=ch.name;
      img.onerror=()=>{mobThumb.innerHTML=`<span>${ch.name[0].toUpperCase()}</span>`;};
      mobThumb.appendChild(img);
    } else {
      mobThumb.innerHTML=`<span>${ch.flag||ch.name[0].toUpperCase()}</span>`;
    }
  }
  if(mobName) mobName.textContent=ch.name;
  if(mobSub)  mobSub.textContent=`${ch.flag||''} ${ch.ctname||ch.country} · Live`;
}

function syncMuteBtn(){
  const MUTED   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
  const UNMUTED = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
  const label = isMuted ? 'Unmute' : 'Mute';
  for(const id of ['mute-btn','mob-mute-btn']){
    const btn=$(id); if(!btn) continue;
    btn.title=label; btn.setAttribute('aria-label',label);
    btn.innerHTML=isMuted ? MUTED : UNMUTED;
  }
}

function showToast(msg, ms=2400){
  toast.textContent=msg; toast.classList.add('show');
  setTimeout(()=>toast.classList.remove('show'),ms);
}

/* ============================================================
   CONTROLS
   ============================================================ */
$('retry-btn').addEventListener('click',()=>{ if(!retryTarget) return; errorOvl.classList.remove('show'); switchTo(retryTarget); });

function toggleMute(){
  isMuted=!isMuted; video.muted=isMuted; syncMuteBtn();
  showToast(isMuted?'🔇 Muted':'🔊 Unmuted');
}
function toggleFullscreen(){
  const w=$('player-wrap');
  document.fullscreenElement
    ?(document.exitFullscreen||document.webkitExitFullscreen).call(document)
    :(w.requestFullscreen||w.webkitRequestFullscreen).call(w);
}

$('mute-btn').addEventListener('click', toggleMute);
$('fullscreen-btn').addEventListener('click', toggleFullscreen);
$('mob-mute-btn').addEventListener('click', toggleMute);
$('mob-fullscreen-btn').addEventListener('click', toggleFullscreen);

/* ============================================================
   SIDEBAR TOGGLE — desktop collapses grid, mobile opens drawer
   ============================================================ */
const app = $('app');

function isMobile() { return window.innerWidth <= 900; }

function closeSidebar(){
  sidebar.classList.remove('open'); sidebarBg.classList.remove('show');
  $('mob-channels').classList.remove('active'); $('mob-watch').classList.add('active');
}

$('sidebar-toggle').addEventListener('click', () => {
  if (isMobile()) {
    const o = sidebar.classList.toggle('open');
    sidebarBg.classList.toggle('show', o);
  } else {
    app.classList.toggle('sidebar-hidden');
  }
});

sidebarBg.addEventListener('click', closeSidebar);
$('mob-watch').addEventListener('click', closeSidebar);
$('mob-channels').addEventListener('click',()=>{
  const o=sidebar.classList.toggle('open'); sidebarBg.classList.toggle('show',o);
  $('mob-channels').classList.toggle('active',o); $('mob-watch').classList.toggle('active',!o);
});
$('mob-search').addEventListener('click',()=>{
  sidebar.classList.add('open'); sidebarBg.classList.add('show');
  $('mob-channels').classList.add('active'); $('mob-watch').classList.remove('active');
  setTimeout(()=>sidebarSearchInput.focus(), 120);
});

/* ============================================================
   ABOUT MODAL
   ============================================================ */
const aboutOverlay = $('about-overlay');

function openAbout() {
  aboutOverlay.classList.add('open');
  $('about-channel-count').textContent = `${allChannels.length.toLocaleString()} channels available`;
  document.body.style.overflow = 'hidden';
}
function closeAbout() {
  aboutOverlay.classList.remove('open');
  document.body.style.overflow = '';
}

$('about-btn').addEventListener('click', openAbout);
$('mob-about').addEventListener('click', openAbout);
$('about-close').addEventListener('click', closeAbout);
aboutOverlay.addEventListener('click', e => { if (e.target === aboutOverlay) closeAbout(); });

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && aboutOverlay.classList.contains('open')) closeAbout();
});
document.addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT') return;
  if(e.key==='m'){ isMuted=!isMuted; video.muted=isMuted; syncMuteBtn(); }
  if(e.key==='f') $('fullscreen-btn').click();
  if(e.key==='b' && !isMobile()) app.classList.toggle('sidebar-hidden');
  if(e.key==='/'){ e.preventDefault(); searchInput.focus(); }
});

/* ============================================================
   INIT
   ============================================================ */
loadAll();
