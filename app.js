'use strict';

const EP = {
  channels:  'https://iptv-org.github.io/api/channels.json',
  streams:   'https://iptv-org.github.io/api/streams.json',
  countries: 'https://iptv-org.github.io/api/countries.json',
};

const PROXY_BASE = 'https://streambox-proxy.geanpaulofrancois.workers.dev/proxy';

const CORS_HOSTS = /hls\.iill\.top/;

function corsProxy(url) {
  if (!url) return url;
  try {
    const p = new URL(url);
    if (!CORS_HOSTS.test(p.host)) return url;
    return `${PROXY_BASE}/${p.host}${p.pathname}${p.search}`;
  } catch { return url; }
}

/* ─── State ───────────────────────────────────────────────────── */
let allChannels    = [];   // full merged list (all countries)
let filteredChs    = [];   // current view after country + cat + search
let countryMap     = {};   // code → { name, flag }
let currentChannel = null;
let currentCat     = 'all';
let currentCountry = 'all';
let hls            = null;
let dashPlayer     = null;
let retryTarget       = null;
let isMuted           = true;
let epgTimer          = null;
let _switchGuardTimer = null;

/* ─── Persistence ─────────────────────────────────────────────── */
const LS_LAST    = 'sb_last_channel';
const LS_FAVS    = 'sb_favourites';
let   favourites = new Set(JSON.parse(localStorage.getItem(LS_FAVS) || '[]'));

function saveFavs() {
  try { localStorage.setItem(LS_FAVS, JSON.stringify([...favourites])); } catch(e){}
}
function saveLastChannel(id) {
  try { localStorage.setItem(LS_LAST, id); } catch(e){}
}
function loadLastChannelId() {
  try { return localStorage.getItem(LS_LAST); } catch(e){ return null; }
}
function toggleFav(id) {
  if (favourites.has(id)) favourites.delete(id);
  else favourites.add(id);
  saveFavs();
  /* Repaint any visible rows that show this channel */
  document.querySelectorAll(`.channel-item[data-id="${id}"] .ch-fav-btn`).forEach(btn => {
    syncFavBtn(btn, favourites.has(id));
  });
  /* If currently in favs tab, refilter */
  if (currentCat === 'favs') applyFilters();
}

let isRestoring = false;  // set true just before restore switchTo, cleared inside
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
  all:'All', favs:'Favourites', general:'General', news:'News',
  entertainment:'Entertainment', sports:'Sports', kids:'Kids',
};

function mapCat(cats = []) {
  for (const c of cats) {
    const k = CAT_MAP[(c||'').toLowerCase().trim()];
    if (k) return k;
  }
  return 'general';
}

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

const PH_CHANNELS = [
  // ── Major free-to-air ────────────────────────────────────────
  { name:'SineManila',           logo:'https://i.imgur.com/zcFUYC5.png',                                                                                                            cat:'entertainment', url:'https://live20.bozztv.com/giatv/giatv-sinemanila/sinemanila/chunks.m3u8' },
  { name:'3rsMovieBoxPh',        logo:'https://i.imgur.com/b4rjf8nl.png',                                                                                                           cat:'entertainment', url:'https://live20.bozztv.com/giatvplayout7/giatv-210731/tracks-v1a1/mono.ts.m3u8' },
  { name:'3rsSinePinoy',         logo:'https://i.imgur.com/OCS1l7Gl.jpg',                                                                                                           cat:'entertainment', url:'https://live20.bozztv.com/giatvplayout7/giatv-210267/tracks-v1a1/mono.ts.m3u8' },
  { name:'Golden Television',    logo:'https://imgur.com/9EGqMKY.png',                                                                                                              cat:'entertainment', url:'https://live20.bozztv.com/akamaissh101/ssh101/gldntventmt/playlist.m3u8' },

  // ── News ─────────────────────────────────────────────────────
  { name:'Bilyonaryo Channel',   logo:null,                                                                                                                                          cat:'news',          url:'https://amg19223-amg19223c11-amgplt0352.playout.now3.amagi.tv/playlist/amg19223-amg19223c11-amgplt0352/playlist.m3u8' },
  { name:'Abante Radyo',         logo:null,                                                                                                                                          cat:'news',          url:'https://amg19223-amg19223c12-amgplt0352.playout.now3.amagi.tv/playlist/amg19223-amg19223c12-amgplt0352/playlist.m3u8' },
  { name:'BBC News',             logo:'https://upload.wikimedia.org/wikipedia/commons/thumb/6/62/BBC_News_2019.svg/1200px-BBC_News_2019.svg.png',                                   cat:'news',          url:'https://vs-hls-push-ww-live.akamaized.net/x=4/i=urn:bbc:pips:service:bbc_news_channel_hd/t=3840/v=pv14/b=5070016/main.m3u8' },
  { name:'RTM ASEAN',            logo:'https://i.imgur.com/skAiUxg.png',                                                                                                            cat:'news',          url:'https://d25tgymtnqzu8s.cloudfront.net/event/smil:event1/chunklist_b2596000_slENG.m3u8' },

  // ── Entertainment ─────────────────────────────────────────────
  { name:'AniPlus HD',           logo:null,                                                                                                                                          cat:'entertainment', url:'https://amg18481-amg18481c1-amgplt0352.playout.now3.amagi.tv/playlist/amg18481-amg18481c1-amgplt0352/playlist.m3u8' },
  { name:'Anime x HiDive',       logo:null,                                                                                                                                          cat:'entertainment', url:'https://amc-anime-x-hidive-1-us.tablo.wurl.tv/4300.m3u8' },
  { name:'Ani-Blast',            logo:'https://i.ibb.co/Rpj2zNY7/1.png',                                                                                                            cat:'entertainment', url:'https://amg19223-amg19223c9-amgplt0019.playout.now3.amagi.tv/playlist/amg19223-amg19223c9-amgplt0019/playlist.m3u8' },
  { name:'Asian Crush',          logo:'https://iyadtv.pages.dev/images/asian_crush_28.png',                                                                                         cat:'entertainment', url:'https://cineverse.g-mana.live/media/1ebfbe30-c35c-4404-8bc5-0339d750eb58/mainManifest.m3u8' },
  { name:'Rakuten Viki',         logo:'https://tse1.mm.bing.net/th/id/OIP.14iQmo2HrOxiL10lttVslgAAAA?rs=1&pid=ImgDetMain&o=7&rm=3',                                                cat:'entertainment', url:'https://fd18f1cadd404894a31a3362c5f319bd.mediatailor.us-east-1.amazonaws.com/v1/master/04fd913bb278d8775298c26fdca9d9841f37601f/RakutenTV-eu_RakutenViki-1/playlist.m3u8' },
  { name:'K-Movies',             logo:'https://th.bing.com/th/id/OIP.uvYKFBubGFR40NtgWh7W8wHaES?rs=1&pid=ImgDetMain',                                                             cat:'entertainment', url:'https://7732c5436342497882363a8cd14ceff4.mediatailor.us-east-1.amazonaws.com/v1/master/04fd913bb278d8775298c26fdca9d9841f37601f/Plex_NewMovies/playlist.m3u8' },
  { name:'Blast Movies',         logo:'https://i.ibb.co/G3sSvQmD/unnamed-2.png',                                                                                                   cat:'entertainment', url:'https://amg19223-amg19223c7-amgplt0351.playout.now3.amagi.tv/playlist/amg19223-amg19223c7-amgplt0351/playlist.m3u8' },
  { name:'Sony Cine',            logo:'https://th.bing.com/th/id/OIP._NGk-Rpn5n6TOVRIjvnZ6QHaHb?rs=1&pid=ImgDetMain',                                                             cat:'entertainment', url:'https://a-cdn.klowdtv.com/live1/cine_720p/chunks.m3u8' },
  { name:'Discovery Asia',       logo:'https://iyadtv.pages.dev/images/discovery_asia_71.png',                                                                                      cat:'entertainment', url:'https://cdn3.skygo.mn/live/disk1/Discovery_Asia/HLSv3-FTA/Discovery_Asia.m3u8' },
  { name:'Arirang',              logo:null,                                                                                                                                          cat:'entertainment', url:'https://amdlive-ch01-ctnd-com.akamaized.net/arirang_1ch/smil:arirang_1ch.smil/playlist.m3u8' },
  { name:'New K-Pop',            logo:null,                                                                                                                                          cat:'entertainment', url:'https://newidco-newkid-1-eu.xiaomi.wurl.tv/playlist.m3u8' },
  { name:'Vevo Pop',             logo:null,                                                                                                                                          cat:'entertainment', url:'https://amg00056-amg00056c6-rakuten-uk-3235.playouts.now.amagi.tv/playlist.m3u8' },
  { name:'AMC+',                 logo:null,                                                                                                                                          cat:'entertainment', url:'https://bcovlive-a.akamaihd.net/ba853de442c140b7b3dc020001597c0a/us-east-1/6245817279001/playlist.m3u8' },
  { name:'AMC Presents',         logo:null,                                                                                                                                          cat:'entertainment', url:'https://amc-amcpresents-1-us.plex.wurl.tv/playlist.m3u8' },
  { name:'MovieSphere',          logo:null,                                                                                                                                          cat:'entertainment', url:'https://amg00353-lionsgatestudio-moviesphere-xumo-zh5u0.amagi.tv/playlist.m3u8' },
  { name:'Wild Earth',           logo:null,                                                                                                                                          cat:'entertainment', url:'https://wildearth-plex.amagi.tv/masterR1080p.m3u8' },
  { name:'RT Documentary',       logo:null,                                                                                                                                          cat:'entertainment', url:'https://rt-rtd.rttv.com/live/rtdoc/playlist_4500Kb.m3u8' },
  { name:'Game Show Network',    logo:null,                                                                                                                                          cat:'entertainment', url:'https://a-cdn.klowdtv.com/live2/gsn_720p/chunks.m3u8' },
  { name:'Cartoon Classics',     logo:'https://tse1.mm.bing.net/th/id/OIP.e3EnrHl_y0kw59ySjxxmQAAAAA?rs=1&pid=ImgDetMain',                                                        cat:'entertainment', url:'https://streams2.sofast.tv/v1/master/611d79b11b77e2f571934fd80ca1413453772ac7/d5543c06-5122-49a7-9662-32187f48aa2c/manifest.m3u8' },

  // ── Kids ─────────────────────────────────────────────────────
  { name:'Moonbug',              logo:null,                                                                                                                                          cat:'kids',          url:'https://moonbug-rokuus.amagi.tv/playlist.m3u8' },
  { name:'Cartoon Channel PH',   logo:null,                                                                                                                                          cat:'kids',          url:'https://live20.bozztv.com/giatv/giatv-cartoonchannelph/cartoonchannelph/chunks.m3u8' },
  { name:'CBeebies',             logo:null,                                                                                                                                          cat:'kids',          url:'https://cdn4.skygo.mn/live/disk1/Cbeebies/HLSv3-FTA/Cbeebies.m3u8' },
  { name:'Pop',                  logo:null,                                                                                                                                          cat:'kids',          url:'https://amg01753-amg01753c6-samsung-au-6678.playouts.now.amagi.tv/playlist.m3u8' },

  // ── General ───────────────────────────────────────────────────
  { name:'Mindanow Network TV',  logo:null,                                                                                                                                          cat:'general',       url:'https://streams.comclark.com/overlay/mindanow/playlist.m3u8' },
  // ── Sports ────────────────────────────────────────────────────
  { name:'DAZN Combat',          logo:null,                                                                                                                                          cat:'sports',        url:'https://dazn-combat-rakuten.amagi.tv/hls/amagi_hls_data_rakutenAA-dazn-combat-rakuten/CDN/master.m3u8' },
  { name:'DAZN Ringside',        logo:null,                                                                                                                                          cat:'sports',        url:'https://aegis-cloudfront-1.tubi.video/bfad29e2-5bee-44f3-8256-127324e8b106/playlist.m3u8' },
  { name:'UFC TV',               logo:null,                                                                                                                                          cat:'sports',        url:'https://amg19223-amg19223c6-amgplt0351.playout.now3.amagi.tv/playlist/amg19223-amg19223c6-amgplt0351/playlist.m3u8' },
  { name:'FIFA+',                logo:null,                                                                                                                                          cat:'sports',        url:'https://ca333c39.wurl.com/v1/sysdata_s_p_a_fifa_6/ohlscdn_us/latest/main/hls/playlist.m3u8' },
  { name:'Tennis+',              logo:null,                                                                                                                                          cat:'sports',        url:'https://amg01935-amg01935c1-amgplt0352.playout.now3.amagi.tv/playlist/amg01935-amg01935c1-amgplt0352/playlist.m3u8' },
  { name:'Red Bull TV',          logo:'https://i.ibb.co/cK5FsbyM/unnamed-1.png',                                                                                                   cat:'sports',        url:'https://d3k3xxewhm1my2.cloudfront.net/playlist.m3u8' },
  { name:'Billiard TV',          logo:null,                                                                                                                                          cat:'sports',        url:'https://1621590671.rsc.cdn77.org/HLS/BILLIARDTV_SCTE.m3u8' },
  { name:'BeIN Sports 2',        logo:null,                                                                                                                                          cat:'sports',        url:corsProxy('https://hls.iill.top/api/beIN-Sports-2/index.m3u8') },
  { name:'BeIN Sports 3',        logo:null,                                                                                                                                          cat:'sports',        url:corsProxy('https://hls.iill.top/api/beIN-Sports-3/index.m3u8') },
  { name:'TNT Sports 1',         logo:null,                                                                                                                                          cat:'sports',        url:corsProxy('https://hls.iill.top/api/TNT-Sports-1/index.m3u8') },
  { name:'TNT Sports 2',         logo:null,                                                                                                                                          cat:'sports',        url:corsProxy('https://hls.iill.top/api/TNT-Sports-2/index.m3u8') },
  { name:'TNT Sports 3',         logo:null,                                                                                                                                          cat:'sports',        url:corsProxy('https://hls.iill.top/api/TNT-Sports-3/index.m3u8') },
  { name:'TNT Sports 4',         logo:null,                                                                                                                                          cat:'sports',        url:corsProxy('https://hls.iill.top/api/TNT-Sports-4/index.m3u8') },
  { name:'Sky Sports F1',        logo:'https://upload.wikimedia.org/wikipedia/en/thumb/d/d3/Sky_Sports_F1.svg/1200px-Sky_Sports_F1.svg.png',                                       cat:'sports',        url:corsProxy('https://hls.iill.top/api/Sky-Sports-F1/index.m3u8') },
].map(ch => ({
  id:      'ph-local-' + ch.name.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,''),
  name:    ch.name,
  logo:    ch.logo,
  cat:     ch.cat,
  url:     ch.url,
  drm:     ch.drm || null,
  status:  'online',
  country: 'PH',
  ctname:  'Philippines',
  flag:    '\uD83C\uDDF5\uD83C\uDDED',
}));

const US_CHANNELS = [
  { name:'National Geographic HD',      logo:'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fc/Natgeologo.svg/960px-Natgeologo.svg.png',             cat:'entertainment', url:'https://tvpass.org/live/NationalGeographicEast/hd' },
  { name:'National Geographic Wild HD', logo:'https://upload.wikimedia.org/wikipedia/commons/thumb/2/27/National_Geographic_Wild_logo.svg/960px-National_Geographic_Wild_logo.svg.png', cat:'entertainment', url:'https://tvpass.org/live/NationalGeographicWildEast/hd' },
].map(ch => ({
  id:      'us-local-' + ch.name.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,''),
  name:    ch.name,
  logo:    ch.logo,
  cat:     ch.cat,
  url:     ch.url,
  drm:     null,
  status:  'online',
  country: 'US',
  ctname:  'United States',
  flag:    '\uD83C\uDDFA\uD83C\uDDF8',
}));
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

async function detectCountry() {
  if (!navigator.geolocation) return null;
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        try {
          const r = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${coords.latitude}&lon=${coords.longitude}&format=json`,
            { signal: AbortSignal.timeout(4000) }
          );
          const j = await r.json();
          const code = j?.address?.country_code?.toUpperCase() || null;
          resolve(code && /^[A-Z]{2}$/.test(code) ? code : null);
        } catch { resolve(null); }
      },
      () => resolve(null),
      { timeout: 8000, maximumAge: 86400000 }
    );
  });
}

async function loadAll() {
  showSkeletons();
  loadBar.classList.remove('done');
  chCount.textContent = 'Fetching channels…';

  /* ── Show PH channels immediately while API loads ─────────────
     This gives instant content instead of a blank skeleton wait. */
  allChannels = [...PH_CHANNELS, ...US_CHANNELS];
  buildSearchIndex();
  buildCountryDropdown();
  syncCatTabs();
  applyFilters();
  renderSuggestions();
  channelTotal.innerHTML = `<span>${allChannels.length.toLocaleString()}</span> channels`;
  if (!$('cat-tab-favs')) {
    const favTab = document.createElement('button');
    favTab.className = 'cat-tab';
    favTab.id = 'cat-tab-favs';
    favTab.dataset.cat = 'favs';
    favTab.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline;vertical-align:-.05em;margin-right:3px"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>Favs`;
    $('cat-tabs').prepend(favTab);
  }

  const timeout = ms => AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;

  const [chRes, stRes, ctRes] = await Promise.allSettled([
    fetch(EP.channels,  { signal: timeout(15000) }),
    fetch(EP.streams,   { signal: timeout(15000) }),
    fetch(EP.countries, { signal: timeout(10000) }),
  ]);

  const preApiCount = allChannels.length;  // snapshot before API results arrive

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

      const sorted = mapped.sort((a,b) => {
        if (a.status==='online' && b.status!=='online') return -1;
        if (b.status==='online' && a.status!=='online') return  1;
        return a.name.localeCompare(b.name);
      });

      /* Merge: keep curated channels at top, append API channels deduped */
      const curatedIds = new Set([...PH_CHANNELS, ...US_CHANNELS].map(c => c.id));
      const apiChannels = sorted.filter(c => !curatedIds.has(c.id));
      allChannels = [...PH_CHANNELS, ...US_CHANNELS, ...apiChannels];

      console.info(`[StreamBox] ${allChannels.length} channels loaded`);
    } catch(e){ console.warn('[StreamBox] channels.json error', e); }
  }

  const prevCount = preApiCount;
  buildSearchIndex();
  /* Only rebuild dropdown/tabs if channel count changed (API added more) */
  if (allChannels.length !== prevCount) {
    buildCountryDropdown();
    syncCatTabs();
  }
  applyFilters();
  renderSuggestions();
  channelTotal.innerHTML = `<span>${allChannels.length.toLocaleString()}</span> channels`;
  loadBar.classList.add('done');

  const lastId = loadLastChannelId();
  if (lastId) {
    const last = allChannels.find(c => c.id === lastId);
    if (last) { isRestoring = true; setTimeout(() => switchTo(last), 300); }
  } else {
    setTimeout(async () => {
      const code = await detectCountry();
      if (code && countryMap[code]) {
        const { name, flag } = countryMap[code];
        selectCountry(code, flag, name);
      }
    }, 800);
  }
}

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

function makeOption(value, flag, label, _unused) {
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

let vsTopSpacer    = null;
let vsBottomSpacer = null;
let vsRafPending   = false;

function renderList(channels) {
  chList.removeEventListener('scroll', onListScroll);

  if (!channels.length) {
    const msg = currentCat === 'favs'
      ? `<li style="padding:32px 14px;text-align:center;color:var(--txt-3);font-size:.8rem;line-height:1.9">No favourites yet.<br>Tap ♡ on any channel to save it here.</li>`
      : `<li style="padding:32px 14px;text-align:center;color:var(--txt-3);font-size:.8rem;line-height:1.8">No channels found.<br>Try a different search, country, or category.</li>`;
    chList.innerHTML = msg;
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

function syncFavBtn(btn, isFav) {
  btn.setAttribute('aria-label', isFav ? 'Remove from favourites' : 'Add to favourites');
  btn.classList.toggle('is-fav', isFav);
  btn.innerHTML = isFav
    ? `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
}

function buildItem(ch, i) {
  const active = currentChannel?.id === ch.id;
  const isFav  = favourites.has(ch.id);
  const li = document.createElement('li');
  li.className = `channel-item${active ? ' active' : ''}`;
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', String(active));
  li.dataset.id = ch.id;

  /* Logo */
  const wrap = document.createElement('div');
  wrap.className = 'ch-logo-wrap';
  wrap.appendChild(makeLogoEl(ch.logo, ch.name, 'ch-letter', ch.country));

  /* Text */
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

  /* Now-playing dot */
  const dot = document.createElement('div');
  dot.className = 'ch-now-badge';

  /* Favourite button */
  const favBtn = document.createElement('button');
  favBtn.className = 'ch-fav-btn';
  syncFavBtn(favBtn, isFav);
  favBtn.addEventListener('click', e => {
    e.stopPropagation();
    toggleFav(ch.id);
  });
  let favTouchStartY = 0;
  favBtn.addEventListener('touchstart', e => {
    favTouchStartY = e.touches[0].clientY;
  }, { passive: true });
  favBtn.addEventListener('touchend', e => {
    const moved = Math.abs(e.changedTouches[0].clientY - favTouchStartY);
    if (moved > 8) return;
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
    toggleFav(ch.id);
  }, { passive: false });

  li.append(wrap, info, dot, favBtn);
  li.addEventListener('click', () => switchTo(ch));

  /* Track touch start position — cancel if user scrolled */
  let touchStartY = 0;
  li.addEventListener('touchstart', e => {
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  li.addEventListener('touchend', e => {
    const moved = Math.abs(e.changedTouches[0].clientY - touchStartY);
    if (moved > 8) return; /* was a scroll, not a tap */
    if (e.cancelable) e.preventDefault();
    switchTo(ch);
  }, { passive: false });

  li.addEventListener('keydown', e => { if (e.key === 'Enter') switchTo(ch); });
  return li;
}

/* Cache of logo URLs that have previously 404'd — skip img for these */
const failedLogos = new Set();

/* ── tv-logo/tv-logos CDN ─────────────────────────────────────
   Builds a candidate URL from channel name + country code.
   Format: [name-slug]-[cc].png
   e.g. "BBC News" + "GB" → bbc-news-gb.png                    */
const TV_LOGO_BASE = 'https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries';

const COUNTRY_DIR = {
  US:'united-states', GB:'united-kingdom', PH:'philippines',
  AU:'australia',     CA:'canada',         DE:'germany',
  FR:'france',        JP:'japan',          KR:'south-korea',
  CN:'china',         IN:'india',          BR:'brazil',
  IT:'italy',         ES:'spain',          NL:'netherlands',
  MX:'mexico',        AR:'argentina',      RU:'russia',
  PL:'poland',        SE:'sweden',         NO:'norway',
  DK:'denmark',       FI:'finland',        PT:'portugal',
  GR:'greece',        TR:'turkey',         SA:'saudi-arabia',
  AE:'united-arab-emirates', SG:'singapore', MY:'malaysia',
  TH:'thailand',      ID:'indonesia',      VN:'vietnam',
  ZA:'south-africa',  NG:'nigeria',        EG:'egypt',
};

function tvLogoUrl(name, countryCode) {
  const dir = COUNTRY_DIR[(countryCode || '').toUpperCase()];
  if (!dir) return null;
  const slug = name.toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const cc = countryCode.toLowerCase();
  return `${TV_LOGO_BASE}/${dir}/${slug}-${cc}.png`;
}

function makeLogoEl(src, name, fallbackClass, countryCode = '') {
  /* If we have a known-good src, use it directly */
  if (src && !failedLogos.has(src)) {
    const img = document.createElement('img');
    img.src    = src;
    img.alt    = name;
    img.width  = 38;
    img.height = 38;
    img.onerror = () => {
      failedLogos.add(src);
      /* Try tv-logo CDN before falling back to letter */
      const cdn = tvLogoUrl(name, countryCode);
      if (cdn && !failedLogos.has(cdn)) {
        img.onerror = () => { failedLogos.add(cdn); img.replaceWith(makeLetterEl(name, fallbackClass)); };
        img.src = cdn;
      } else {
        img.replaceWith(makeLetterEl(name, fallbackClass));
      }
    };
    return img;
  }

  /* No src — try tv-logo CDN first */
  const cdn = tvLogoUrl(name, countryCode);
  if (cdn && !failedLogos.has(cdn)) {
    const img = document.createElement('img');
    img.src    = cdn;
    img.alt    = name;
    img.width  = 38;
    img.height = 38;
    img.onerror = () => {
      failedLogos.add(cdn);
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
    if (currentCat === 'favs') return favourites.has(ch.id);
    if (currentCat !== 'all' && ch.cat !== currentCat) return false;
    if (q && !ch._nameL.includes(q) && !ch._ctnameL.includes(q))  return false;
    return true;
  });

  renderList(filteredChs);

  const label   = currentCat === 'all' ? 'channels' : `${TAB_LABEL[currentCat] || currentCat} channels`;
  const ctLabel = currentCountry === 'all' ? 'Worldwide' : (countryMap[currentCountry]?.name || currentCountry);
  chCount.innerHTML = `<span>${filteredChs.length.toLocaleString()}</span> ${label} · ${esc(ctLabel)}`;
}

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
    logoWrap.appendChild(makeLogoEl(ch.logo, ch.name, 'sug-letter', ch.country));
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

const searchDropdown = $('search-results-dropdown');
const searchClear    = $('search-clear');
const MAX_RESULTS    = 20;
let   activeResultIdx = -1;

function openSearchDropdown(results, q) {
  if (!results.length) {
    searchDropdown.innerHTML = `<div class="sr-empty">No channels found for "<strong>${esc(q)}</strong>"</div>`;
  } else {
    const frag = document.createDocumentFragment();
    const header = document.createElement('div');
    header.className = 'sr-header';
    header.textContent = `${results.length > MAX_RESULTS ? MAX_RESULTS + '+' : results.length} result${results.length !== 1 ? 's' : ''} for "${q}"`;
    frag.appendChild(header);

    results.slice(0, MAX_RESULTS).forEach(ch => {
      const item = document.createElement('div');
      item.className = 'sr-item';
      if (currentChannel?.id === ch.id) item.classList.add('active');
      item.setAttribute('role', 'option');
      item.dataset.id = ch.id;

      const logo = document.createElement('div');
      logo.className = 'sr-logo';
      logo.appendChild(makeLogoEl(ch.logo, ch.name, 'sr-letter', ch.country));

      const info = document.createElement('div');
      info.className = 'sr-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'sr-name';
      nameEl.textContent = ch.name;
      const meta = document.createElement('div');
      meta.className = 'sr-meta';
      meta.innerHTML = `<span>${ch.flag || ''}</span> ${esc(ch.ctname || ch.country)} · ${esc(TAB_LABEL[ch.cat] || ch.cat)}`;
      info.append(nameEl, meta);

      /* Fav button in search result */
      const favBtn = document.createElement('button');
      favBtn.className = 'ch-fav-btn sr-fav-btn';
      syncFavBtn(favBtn, favourites.has(ch.id));
      favBtn.addEventListener('mousedown', e => {
        e.preventDefault();
        e.stopPropagation();
        toggleFav(ch.id);
        syncFavBtn(favBtn, favourites.has(ch.id));
      });
      item.append(logo, info, favBtn);
      item.addEventListener('mousedown', e => {
        e.preventDefault(); // don't blur the input
        switchTo(ch);
        closeSearchDropdown();
      });
      frag.appendChild(item);
    });

    searchDropdown.innerHTML = '';
    searchDropdown.appendChild(frag);
  }

  activeResultIdx = -1;
  searchDropdown.hidden = false;
}

function closeSearchDropdown() {
  searchDropdown.hidden = true;
  searchDropdown.innerHTML = '';
  activeResultIdx = -1;
}

function navigateDropdown(dir) {
  const items = searchDropdown.querySelectorAll('.sr-item');
  if (!items.length) return;
  items[activeResultIdx]?.classList.remove('focused');
  activeResultIdx = Math.max(-1, Math.min(items.length - 1, activeResultIdx + dir));
  if (activeResultIdx >= 0) {
    items[activeResultIdx].classList.add('focused');
    items[activeResultIdx].scrollIntoView({ block: 'nearest' });
  }
}

/* ── Shared search handler — debounced ────────────────────────── */
function handleSearch(val) {
  searchInput.value        = val;
  sidebarSearchInput.value = val;

  /* Show/hide clear button */
  if (searchClear) searchClear.hidden = !val.trim();

  const q = val.trim().toLowerCase();

  if (!q) {
    closeSearchDropdown();
    /* Reset sidebar to full list */
    clearTimeout(searchDebounce);
    applyFilters();
    return;
  }

  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    /* Search across ALL channels regardless of country/cat filter */
    const results = allChannels.filter(ch =>
      ch._nameL.includes(q) || ch._ctnameL.includes(q)
    );
    openSearchDropdown(results, val.trim());
    /* Also update sidebar list */
    applyFilters();
  }, 120);
}

searchInput.addEventListener('input',        () => handleSearch(searchInput.value));
sidebarSearchInput.addEventListener('input', () => handleSearch(sidebarSearchInput.value));

/* Clear button */
searchClear?.addEventListener('click', () => {
  searchInput.value = '';
  sidebarSearchInput.value = '';
  searchClear.hidden = true;
  closeSearchDropdown();
  applyFilters();
  searchInput.focus();
});

/* Keyboard navigation in dropdown */
searchInput.addEventListener('keydown', e => {
  if (searchDropdown.hidden) return;
  if (e.key === 'ArrowDown')  { e.preventDefault(); navigateDropdown(1); }
  if (e.key === 'ArrowUp')    { e.preventDefault(); navigateDropdown(-1); }
  if (e.key === 'Enter') {
    const focused = searchDropdown.querySelector('.sr-item.focused');
    if (focused) {
      const ch = allChannels.find(c => c.id === focused.dataset.id);
      if (ch) { switchTo(ch); closeSearchDropdown(); }
    }
  }
  if (e.key === 'Escape') { closeSearchDropdown(); }
});

/* Close dropdown on blur (with slight delay to allow mousedown on items) */
searchInput.addEventListener('blur', () => setTimeout(closeSearchDropdown, 150));

/* Reopen if input regains focus and has a value */
searchInput.addEventListener('focus', () => {
  if (searchInput.value.trim()) handleSearch(searchInput.value);
});

catTabs.addEventListener('click', e => {
  const tab = e.target.closest('.cat-tab');
  if (!tab) return;
  document.querySelectorAll('.cat-tab').forEach(t=>t.classList.remove('active'));
  tab.classList.add('active');
  currentCat = tab.dataset.cat;
  applyFilters();
});

function switchTo(ch) {
  if (!ch?.url) { showToast('⚠ No stream URL for this channel'); return; }

  currentChannel = ch;
  retryTarget    = ch;
  pausedAt       = null;
  saveLastChannel(ch.id);

  /* Mark active by data-id — works regardless of virtual scroll window */
  document.querySelectorAll('.channel-item').forEach(el => {
    const isActive = el.dataset.id === ch.id;
    el.classList.toggle('active', isActive);
    el.setAttribute('aria-selected', String(isActive));
  });

  /* Scroll the list so the selected row is visible */
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
  stopStallDetector();
  clearTimeout(stallTimer);
  bufferOvl.classList.add('show');  // show spinner immediately on channel switch
  syncPlayPauseBtn();
  updateInfoBar(ch);
  closeSidebar();

  const wasRestoring = isRestoring;
  if (isRestoring) {
    /* Page-load restore: muted so browser allows autoplay */
    video.muted = true;
    isMuted     = true;
    isRestoring = false;
  } else {
    video.muted = false;
    isMuted     = false;
  }
  syncMuteBtn();

  const isDash = ch.url.includes('.mpd');
  isDash ? playDash(ch) : playHls(ch);

  /* Safety net: if playing never fires within 12s, reload once.
     Use a module-level timer so any prior guard is always cancelled first. */
  clearTimeout(_switchGuardTimer);
  if (!wasRestoring) {
    _switchGuardTimer = setTimeout(() => {
      if (currentChannel?.id === ch.id && !isPlaying && bufferOvl.classList.contains('show')) {
        console.info('[StreamBox] play never fired after 12s — retrying');
        switchTo(ch);
      }
    }, 12000);
    video.addEventListener('playing', () => clearTimeout(_switchGuardTimer), { once: true });
  }

  renderSuggestions();
}

/* ── HLS playback ───────────────────────────────────────────────── */
function makeHlsConfig() {
  return {
    enableWorker:              true,
    lowLatencyMode:            false,
    /* Buffer: short so playback starts fast on any connection */
    backBufferLength:          8,
    maxBufferLength:           16,
    maxMaxBufferLength:        30,
    maxBufferHole:             1.0,   // was 0.5 — mobile streams have larger gaps
    /* ABR: conservative start so mobile doesn't lock onto 1080p immediately */
    startLevel:                -1,
    abrEwmaDefaultEstimate:    1500000, // avoid ES2021 _ separator for old WebView
    /* Timeouts: cap hanging requests on flaky mobile networks */
    fragLoadingTimeOut:        8000,
    fragLoadingMaxRetry:       4,
    fragLoadingRetryDelay:     500,
    levelLoadingTimeOut:       8000,
    levelLoadingMaxRetry:      4,
    levelLoadingRetryDelay:    500,
    manifestLoadingTimeOut:    10000,
    manifestLoadingMaxRetry:   3,
    manifestLoadingRetryDelay: 1000,
  };
}

function playHls(ch) {
  if (dashPlayer) { try { dashPlayer.destroy(); } catch(e){} dashPlayer = null; }

  if (Hls.isSupported()) {
    if (hls) { hls.destroy(); hls = null; }
    hls = new Hls(makeHlsConfig());
    hls.loadSource(ch.url); hls.attachMedia(video); bindHlsEvents();
    video.play().catch(() => {});
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    if (hls) { hls.destroy(); hls = null; }
    video.src = ch.url; video.play().catch(() => {});
  } else {
    showErr('HLS is not supported in this browser.');
  }
}

/* ── DASH + ClearKey DRM playback ──────────────────────────────── */
function playDash(ch) {
  /* Tear down any active HLS player */
  if (hls) { hls.destroy(); hls = null; }

  if (!window.dashjs) {
    showErr('DASH playback is not supported in this browser.');
    return;
  }

  /* Always create a fresh player to avoid stale protection state */
  if (dashPlayer) { try { dashPlayer.destroy(); } catch(e){} }
  dashPlayer = dashjs.MediaPlayer().create();

  dashPlayer.updateSettings({
    streaming: {
      lowLatencyEnabled: false,
      delay: { liveDelay: 6 },
      buffer: { fastSwitchEnabled: true, stableBufferTime: 8, stallThreshold: 0.5 },
      abr: { initialBitrate: { video: 1500 }, autoSwitchBitrate: { video: true } },
    },
  });

  /* Build ClearKey protection data.
     Must be set BEFORE initialize().
     dash.js clearkeys map: { "kid_base64url": "key_base64url" }
     The KID bytes must also be represented as a hex string in the
     'laURL' variant — we support both formats by providing clearkeys. */
  if (ch.drm) {
    const clearkeys = {};
    for (const [hexKid, hexKey] of Object.entries(ch.drm)) {
      clearkeys[hexToBase64url(hexKid)] = hexToBase64url(hexKey);
    }
    dashPlayer.setProtectionData({
      'org.w3.clearkey': { clearkeys },
    });
  }

  dashPlayer.initialize(video, ch.url, true);

  dashPlayer.on(dashjs.MediaPlayer.events.ERROR, e => {
    if (e?.error === 'capability' || e?.error === 'mediasource') return;
    console.warn('[StreamBox] DASH error', e);
    showBuf(false);
    showErr('Stream error. Channel may be offline or geo-blocked.');
  });

  dashPlayer.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
    showBuf(false);
  });

  /* PLAYBACK_WAITING fires during normal ABR switches — don't show spinner for it.
     The stall detector below handles genuine buffering. */
  dashPlayer.on(dashjs.MediaPlayer.events.PLAYBACK_PLAYING, () => showBuf(false));
}

/* Convert hex string to base64url (for ClearKey) */
function hexToBase64url(hex) {
  const bytes = new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function updateEpgUI(prog) {
  /* Badge programme line */
  const nowProg  = $('now-programme');
  const progTitle = $('now-prog-title');
  const progFill  = $('now-prog-fill');

  /* Info bar EPG strip */
  const infoEpg   = $('info-epg');
  const epgTitle  = $('info-epg-title');
  const epgTime   = $('info-epg-time');
  const epgFill   = $('info-epg-fill');

  if (!prog) {
    if (nowProg)  nowProg.hidden  = true;
    if (infoEpg)  infoEpg.hidden  = true;
    return;
  }

  const nowSec   = Math.floor(Date.now() / 1000);
  const duration = prog.stop_utc - prog.start_utc;
  const elapsed  = Math.max(0, nowSec - prog.start_utc);
  const pct      = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0;

  const startStr = fmtTime(prog.start_utc);
  const endStr   = fmtTime(prog.stop_utc);
  const timeStr  = `${startStr}–${endStr}`;

  /* Now Playing badge */
  if (nowProg && progTitle && progFill) {
    progTitle.textContent = prog.title || '';
    progFill.style.width  = `${pct}%`;
    nowProg.hidden = false;
  }

  /* Info bar */
  if (infoEpg && epgTitle && epgTime && epgFill) {
    epgTitle.textContent = prog.title || '';
    epgTime.textContent  = timeStr;
    epgFill.style.width  = `${pct}%`;
    infoEpg.hidden = false;
  }
}

function fmtTime(utcSec) {
  const d = new Date(utcSec * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

async function loadEpg(ch) {
  /* fetchEpg is not yet implemented — bail out silently */
  if (typeof fetchEpg !== 'function') return;

  /* Clear previous */
  clearInterval(epgTimer);
  const nowProg = $('now-programme');
  const infoEpg = $('info-epg');
  if (nowProg) nowProg.hidden = true;
  if (infoEpg) infoEpg.hidden = true;

  const prog = await fetchEpg(ch);
  if (!prog || currentChannel?.id !== ch.id) return; /* stale — user switched channel */

  updateEpgUI(prog);

  /* Tick progress bar every 30s */
  epgTimer = setInterval(() => {
    if (currentChannel?.id !== ch.id) { clearInterval(epgTimer); return; }
    updateEpgUI(prog);
  }, 30000);
}

function bindHlsEvents() {
  let mediaErrCount = 0;

  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    mediaErrCount = 0;
    showBuf(false); showBadge(currentChannel); video.play().catch(() => {});
  });

  hls.on(Hls.Events.FRAG_LOADED, () => {
    if (bufferOvl.classList.contains('show')) showBuf(false);
  });

  hls.on(Hls.Events.ERROR, (_, d) => {
    if (!d.fatal) {
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR &&
          (d.details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT ||
           d.details === Hls.ErrorDetails.LEVEL_LOAD_TIMEOUT)) {
        hls.startLoad();
      }
      return;
    }
    showBuf(false);
    if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
      hls.startLoad();
    } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
      mediaErrCount++;
      if (mediaErrCount <= 3) hls.recoverMediaError();
      else showErr('Playback error. Channel may be temporarily down.');
    } else {
      showErr('Playback error. Channel may be temporarily down.');
    }
  });
}

/* Clear spinner and show Resume overlay when exiting fullscreen on mobile */
function onFullscreenExit() {
  showBuf(false);
  if (!currentChannel) return;
  /* Resume overlay only on mobile — desktop/laptop/tablet auto-resumes */
  if (isMobile()) {
    showResumeOverlay();
  } else {
    resumeAfterFullscreen();
  }
}

function showResumeOverlay() {
  /* Remove any existing overlay */
  const existing = $('resume-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'resume-overlay';
  overlay.innerHTML = `
    <button id="resume-btn">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      Resume
    </button>
  `;
  $('player-wrap').appendChild(overlay);

  $('resume-btn').addEventListener('click', () => {
    overlay.remove();
    resumeAfterFullscreen();
  });
  $('resume-btn').addEventListener('touchend', e => {
    if (e.cancelable) e.preventDefault();
    overlay.remove();
    resumeAfterFullscreen();
  }, { passive: false });
}

function resumeAfterFullscreen() {
  if (!currentChannel) return;

  /* If paused for a long time, do a full reload to snap to live edge */
  const pausedSec = pausedAt ? (Date.now() - pausedAt) / 1000 : 0;
  if (pausedSec > 10) {
    pausedAt = null;
    switchTo(currentChannel);
    return;
  }

  pausedAt = null;

  if (currentChannel.url.includes('.mpd')) {
    video.play().catch(() => {});
    return;
  }

  if (hls) { hls.destroy(); hls = null; }

  if (Hls.isSupported()) {
    hls = new Hls(makeHlsConfig());
    hls.loadSource(currentChannel.url);
    hls.attachMedia(video);
    bindHlsEvents();
    video.play().catch(() => {});
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = currentChannel.url;
    video.play().catch(() => {});
  }
}

document.addEventListener('fullscreenchange',       () => { if (!document.fullscreenElement)       onFullscreenExit(); });
document.addEventListener('webkitfullscreenchange', () => { if (!document.webkitFullscreenElement) onFullscreenExit(); });
video.addEventListener('webkitendfullscreen',       () => onFullscreenExit());
/* 'waiting' and 'stalled' fire too eagerly on mobile (during normal
   ABR switches). We use the stall detector (currentTime polling) instead. */
video.addEventListener('playing',    () => { showBuf(false); startStallDetector(); });
video.addEventListener('canplay',    () => { showBuf(false); });
video.addEventListener('error',      () => { showBuf(false); stopStallDetector(); if(currentChannel) showErr('Could not load stream.'); });

function showErr(msg) {
  errorMsg.textContent = msg;
  errorOvl.classList.add('show');
  /* Hide play/pause when stream fails */
  const btn = $('playpause-btn');
  if (btn) btn.hidden = true;
}

function showBadge(ch) {
  if (!ch) return;
  nowName.textContent = ch.name;
  nowLogo.innerHTML   = '';
  if (ch.logo) {
    const img = document.createElement('img');
    img.src = ch.logo; img.alt = ch.name;
    img.onerror = () => { nowLogo.textContent = ch.name[0].toUpperCase(); };
    nowLogo.appendChild(img);
  } else { nowLogo.textContent = ch.name[0].toUpperCase(); }
  nowBadge.classList.remove('visible');
  void nowBadge.offsetWidth;
  nowBadge.classList.add('visible');
}
function hideBadge() { nowBadge.classList.remove('visible'); }

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
  /* Show/hide the in-player mute hint */
  const hint = $('mute-hint');
  if (hint) hint.hidden = !(isMuted && currentChannel);
}

function showToast(msg, ms=2400){
  toast.textContent=msg; toast.classList.add('show');
  setTimeout(()=>toast.classList.remove('show'),ms);
}

$('retry-btn').addEventListener('click',()=>{ if(!retryTarget) return; errorOvl.classList.remove('show'); switchTo(retryTarget); });

/* Clicking the mute hint unmutes */
$('mute-hint').addEventListener('click', () => {
  isMuted = false;
  video.muted = false;
  if (video.volume === 0) video.volume = 1;
  syncMuteBtn();
  showToast('🔊 Unmuted');
});

function toggleMute(){
  isMuted=!isMuted; video.muted=isMuted; syncMuteBtn();
  showToast(isMuted?'🔇 Muted':'🔊 Unmuted');
}
/* ── Fullscreen — works on both desktop and mobile (iOS + Android) */
function toggleFullscreen() {
  const w = $('player-wrap');

  if (document.fullscreenElement || document.webkitFullscreenElement) {
    /* Exit fullscreen */
    (document.exitFullscreen || document.webkitExitFullscreen ||
     document.mozCancelFullScreen || document.msExitFullscreen
    ).call(document);
    return;
  }

  /* iOS Safari: must fullscreen the <video> element directly */
  if (video.webkitEnterFullscreen) {
    video.webkitEnterFullscreen();
    return;
  }

  /* Android Chrome / desktop: fullscreen the player wrapper */
  (w.requestFullscreen || w.webkitRequestFullscreen ||
   w.mozRequestFullScreen || w.msRequestFullscreen
  ).call(w);
}

/* ── Buffer overlay ──────────────────────────────────────────────
   showBuf(true) only shows the spinner after 2s of genuine stall.
   We use a stall detector based on currentTime not advancing rather
   than relying on 'waiting'/'stalled' events which fire too eagerly
   on mobile (during ABR switches, segment fetches, etc).            */
let stallTimer     = null;
let syncBtnPending = false;
let _lastTime      = -1;
let _stallStart    = 0;
let _stallInterval = null;   // replaces rAF — polls every 500ms to save battery

function startStallDetector() {
  if (_stallInterval) return;
  _lastTime   = video.currentTime;
  _stallStart = 0;

  _stallInterval = setInterval(() => {
    if (video.paused || video.ended || !currentChannel) {
      _stallStart = 0; _lastTime = video.currentTime; return;
    }
    if (video.currentTime !== _lastTime) {
      _lastTime   = video.currentTime;
      _stallStart = 0;
      if (bufferOvl.classList.contains('show')) showBuf(false);
      return;
    }
    /* currentTime not advancing */
    if (_stallStart === 0) _stallStart = Date.now();
    const stalledMs = Date.now() - _stallStart;
    if (stalledMs > 2000 && !bufferOvl.classList.contains('show')) {
      bufferOvl.classList.add('show');
      scheduleSyncBtn();
    }
    if (stalledMs > 15000 && currentChannel) {
      console.info('[StreamBox] Stall >15s — reloading stream');
      stopStallDetector();
      switchTo(currentChannel);
    }
  }, 500);
}

function stopStallDetector() {
  if (_stallInterval) { clearInterval(_stallInterval); _stallInterval = null; }
  _stallStart = 0;
}

function showBuf(v) {
  clearTimeout(stallTimer);
  if (v && video.paused) return;
  if (v) {
    stallTimer = setTimeout(() => {
      if (video.paused) return;
      bufferOvl.classList.add('show');
      scheduleSyncBtn();
    }, 2000);
  } else {
    bufferOvl.classList.remove('show');
    scheduleSyncBtn();
  }
}

function scheduleSyncBtn() {
  if (syncBtnPending) return;
  syncBtnPending = true;
  requestAnimationFrame(() => { syncBtnPending = false; syncPlayPauseBtn(); });
}

let isPlaying = false;
let pausedAt  = null;

const PLAY_SVG  = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
const PAUSE_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><line x1="6" y1="4" x2="6" y2="20" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><line x1="18" y1="4" x2="18" y2="20" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>`;
let _lastBtnState = null;

function syncPlayPauseBtn() {
  const btn = $('playpause-btn'); if (!btn) return;
  const hasError   = errorOvl.classList.contains('show');
  const isIdle     = !idleScreen.classList.contains('hidden');
  const isLoading  = bufferOvl.classList.contains('show');
  const shouldHide = !currentChannel || hasError || isIdle || isLoading;
  const state = `${isPlaying}|${shouldHide}`;
  if (state === _lastBtnState) return;
  _lastBtnState = state;
  btn.innerHTML = isPlaying ? `${PAUSE_SVG} Pause` : `${PLAY_SVG} Play`;
  btn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
  btn.hidden = shouldHide;
  btn.style.opacity = isPlaying ? '' : '1';
}

/* ── Player hover / idle controls ──────────────────────────────
   Show overlay + button on mouse move, hide after 3s of inactivity */
let playerIdleTimer = null;
const playerWrap = $('player-wrap');

function showPlayerControls() {
  playerWrap.classList.add('controls-visible');
  clearTimeout(playerIdleTimer);
  if (isPlaying) {
    playerIdleTimer = setTimeout(() => {
      playerWrap.classList.remove('controls-visible');
    }, 3000);
  }
}

playerWrap.addEventListener('mousemove',  showPlayerControls);
playerWrap.addEventListener('mouseenter', showPlayerControls);
playerWrap.addEventListener('mouseleave', () => {
  clearTimeout(playerIdleTimer);
  playerWrap.classList.remove('controls-visible');
});

function togglePlayPause() {
  if (!currentChannel) return;
  if (!isPlaying) {
    const pausedSec = pausedAt ? (Date.now() - pausedAt) / 1000 : 0;
    if (pausedSec > 10) {
      pausedAt = null;
      switchTo(currentChannel);
      return;
    }
    video.play().catch(() => {});
    pausedAt = null;
  } else {
    video.pause();
    pausedAt = Date.now();
  }
}

video.addEventListener('play',  () => { isPlaying = true;  _lastBtnState = null; scheduleSyncBtn(); showPlayerControls(); startStallDetector(); });
video.addEventListener('pause', () => {
  isPlaying = false;
  clearTimeout(stallTimer);
  stopStallDetector();
  bufferOvl.classList.remove('show');
  _lastBtnState = null;
  scheduleSyncBtn();
  clearTimeout(playerIdleTimer);
  playerWrap.classList.add('controls-visible');
});

$('mute-btn').addEventListener('click', toggleMute);
$('fullscreen-btn').addEventListener('click', toggleFullscreen);
$('mob-mute-btn').addEventListener('click', toggleMute);
$('mob-fullscreen-btn').addEventListener('click', toggleFullscreen);
$('playpause-btn').addEventListener('click', togglePlayPause);

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

const helpOverlay = $('help-overlay');

function openHelp()  { helpOverlay.classList.add('open');    document.body.style.overflow = 'hidden'; }
function closeHelp() { helpOverlay.classList.remove('open'); document.body.style.overflow = ''; }

$('help-btn').addEventListener('click',  openHelp);
$('mob-help').addEventListener('click',  openHelp);
$('help-close').addEventListener('click', closeHelp);
helpOverlay.addEventListener('click', e => { if (e.target === helpOverlay) closeHelp(); });

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && helpOverlay.classList.contains('open')) closeHelp();
});
const aboutOverlay = $('about-overlay');

function openAbout() {
  aboutOverlay.classList.add('open');
  $('about-channel-count').textContent = `${allChannels.length.toLocaleString()} channels available`;
  document.body.style.overflow = 'hidden';

  /* Wire copy account number button (once) */
  const copyBtn   = $('copy-acct-btn');
  const copyLabel = $('copy-acct-label');
  if (copyBtn && !copyBtn._wired) {
    copyBtn._wired = true;
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText('017356058551');
      } catch {
        const range = document.createRange();
        range.selectNode($('acct-number'));
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        document.execCommand('copy');
        window.getSelection().removeAllRanges();
      }
      copyLabel.textContent = 'Copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => { copyLabel.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 2000);
    });
  }
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
  if(e.key===' '){ e.preventDefault(); togglePlayPause(); }
  if(e.key==='b' && !isMobile()) app.classList.toggle('sidebar-hidden');
  if(e.key==='/'){ e.preventDefault(); searchInput.focus(); }
});


/* ── Mobile background recovery ───────────────────────────────── */
let _hiddenAt = null;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    _hiddenAt = Date.now();
    stopStallDetector();
    clearTimeout(stallTimer);
    bufferOvl.classList.remove('show');
    return;
  }

  if (!currentChannel) { _hiddenAt = null; return; }
  const away = _hiddenAt ? Date.now() - _hiddenAt : 0;
  _hiddenAt = null;

  if (away > 30000) {
    /* Long absence — full reload to snap back to live edge */
    switchTo(currentChannel);
  } else if (away > 5000) {
    /* Medium absence — mobile browsers drop the MSE buffer while backgrounded.
       Simply calling play() won't recover a dead HLS session; we need to
       reload the source. For DASH, play() is usually sufficient. */
    if (currentChannel.url.includes('.mpd')) {
      video.play().catch(() => {});
      const t = setTimeout(() => {
        if (video.paused || video.readyState < 3) switchTo(currentChannel);
      }, 3000);
      video.addEventListener('playing', () => clearTimeout(t), { once: true });
    } else if (hls) {
      /* Reload HLS from current position without a full switchTo */
      hls.stopLoad();
      hls.startLoad(-1); // -1 = live edge
      video.play().catch(() => {});
      const t = setTimeout(() => {
        if (video.paused || video.readyState < 3) switchTo(currentChannel);
      }, 4000);
      video.addEventListener('playing', () => clearTimeout(t), { once: true });
    } else {
      /* Native HLS (Safari/iOS) — just reload src */
      switchTo(currentChannel);
    }
  } else {
    /* Short absence — try play, reload if it doesn't recover quickly */
    video.play().catch(() => {});
    const t = setTimeout(() => {
      if (video.paused || video.readyState < 3) switchTo(currentChannel);
    }, 3000);
    video.addEventListener('playing', () => clearTimeout(t), { once: true });
  }
});

loadAll();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(reg => console.info('[StreamBox] SW registered, scope:', reg.scope))
      .catch(err => console.warn('[StreamBox] SW registration failed:', err));
  });
}

/* Capture the install prompt and show it after a channel is played */
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  /* Only show on real mobile devices — not desktop browsers at narrow widths */
  const isTouchDevice = ('ontouchstart' in window || navigator.maxTouchPoints > 1);
  const isMobileUA    = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
  if (!isTouchDevice && !isMobileUA) return;
  setTimeout(() => {
    if (deferredInstallPrompt) showInstallBanner();
  }, 20000);
});

function showInstallBanner() {
  const existing = $('install-banner');
  if (existing) return;

  const banner = document.createElement('div');
  banner.id = 'install-banner';
  banner.innerHTML = `
    <span class="install-banner-text">📺 Add StreamBox to your home screen</span>
    <button class="install-banner-btn" id="install-accept">Install</button>
    <button class="install-banner-dismiss" id="install-dismiss" aria-label="Dismiss">✕</button>
  `;
  document.body.appendChild(banner);

  $('install-accept').addEventListener('click', async () => {
    banner.remove();
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    console.info('[StreamBox] PWA install:', outcome);
    deferredInstallPrompt = null;
  });

  $('install-dismiss').addEventListener('click', () => {
    banner.remove();
    deferredInstallPrompt = null;
  });
}

window.addEventListener('appinstalled', () => {
  showToast('✅ StreamBox installed!');
  deferredInstallPrompt = null;
  const b = $('install-banner');
  if (b) b.remove();
});
