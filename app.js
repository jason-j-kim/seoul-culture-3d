/* 서울 문화시설 3D 연구 플랫폼 — 애플리케이션 로직
 * 기반: MapLibre GL JS + OpenFreeMap(OSM 벡터타일, 실제 건물) + AWS Terrain Tiles(실측 DEM)
 * 좌표계: WGS84 / EPSG:4326
 */

// ---------- 유형별 색상 (절제된 연구용 팔레트) ----------
const TYPE_COLORS = {
  "미술관": "#c0392b",
  "박물관": "#8e5a2b",
  "갤러리·전시공간": "#e07b54",
  "공연장": "#5b3fa8",
  "콘서트홀": "#7d5fd3",
  "국악공연시설": "#9b59b6",
  "영화관·시네마테크": "#34495e",
  "공공도서관": "#2471a3",
  "작은도서관": "#5dade2",
  "복합문화공간": "#148f77",
  "문화원·지역문화센터": "#45b39d",
  "역사유적·문화재": "#7d6608",
  "궁궐·전통문화시설": "#b7950b",
  "기념관·기념물": "#909497",
  "과학문화시설": "#1abc9c",
  "스페셜티 카페": "#6f4e37",
};
const TYPES = Object.keys(TYPE_COLORS);
const GUS = ["종로구","중구","용산구","성동구","광진구","동대문구","중랑구","성북구","강북구","도봉구","노원구","은평구","서대문구","마포구","양천구","강서구","구로구","금천구","영등포구","동작구","관악구","서초구","강남구","송파구","강동구"];

// ---------- 대표 장면 ----------
const SCENES = [
  { c:[127.02,37.545], z:10.6, p:58, b:105, note:"서울 전체 조감 — 서쪽 상공에서 동쪽 조망" },
  { c:[126.977,37.578], z:14.2, p:62, b:-12, note:"역사도심 — 광화문·경복궁·북악산" },
  { c:[126.995,37.520], z:12.2, p:55, b:75, note:"한강 문화축" },
  { c:[127.045,37.505], z:13.2, p:55, b:15, note:"강남 문화시설" },
  { c:[126.905,37.560], z:13.2, p:55, b:-35, note:"서북권 창작문화축" },
  { c:[127.055,37.645], z:12.4, p:52, b:5, note:"동북권 문화 접근성" },
  { c:[126.99,37.55], z:10.8, p:35, b:0, note:"문화소외지역 분석", underserved:true },
];

// ---------- 지도 초기화 ----------
// 스타일을 직접 받아 저줌 배경 래스터(ne2_shaded)를 제거 — 일부 환경에서 소스 로드가
// 완료 상태로 전환되지 않아 초기화가 멈추는 문제 회피 (서울 축척에서는 불필요한 소스)
let map;
let FAC = null, STATS = null, mode = "real";
let extrusionLayers = [];
let initDone = false;

(async () => {
  const style = await fetch("https://tiles.openfreemap.org/styles/liberty").then(r => r.json());
  if (style.sources.ne2_shaded) {
    delete style.sources.ne2_shaded;
    style.layers = style.layers.filter(l => l.source !== "ne2_shaded");
  }
  map = new maplibregl.Map({
    container: "map",
    style,
    center: [126.99, 37.55],
    zoom: 10.6, pitch: 45, bearing: 0,
    maxPitch: 72, hash: false, antialias: false,
    failIfMajorPerformanceCaveat: false,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");
  map.on("load", init);
  // 안전장치: load 이벤트가 지연되어도 스타일이 준비되면 초기화 진행
  setTimeout(() => { if (!initDone && map.getStyle()) init(); }, 15000);
})();

async function init() {
  if (initDone) return;
  initDone = true;
  // ----- 실측 지형 (AWS Terrarium DEM) -----
  map.addSource("dem", {
    type: "raster-dem",
    tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
    encoding: "terrarium", tileSize: 256, maxzoom: 13,
    attribution: "AWS Terrain Tiles (SRTM 등)",
  });
  map.setTerrain({ source: "dem", exaggeration: 1.2 });
  map.addLayer({
    id: "hillshade", type: "hillshade", source: "dem",
    paint: { "hillshade-exaggeration": 0.35, "hillshade-shadow-color": "#5a5145", "hillshade-highlight-color": "#ffffff" },
  }, firstSymbolId());
  map.setSky && map.setSky({ "sky-color": "#bcd3e8", "horizon-color": "#e8eef2", "fog-color": "#e6e9ec", "sky-horizon-blend": 0.6 });

  // 건물 압출 레이어 식별(스타일 내 실제 건물 3D 레이어)
  extrusionLayers = map.getStyle().layers.filter(l => l.type === "fill-extrusion").map(l => l.id);

  // ----- 데이터 로드 (DATA_V: 데이터 갱신 시 캐시 무효화) -----
  const DATA_V = "4";
  const [fac, districts, grid, subway, statsJ] = await Promise.all([
    fetch("data/facilities.geojson?v=" + DATA_V).then(r => r.json()),
    fetch("data/districts.geojson?v=" + DATA_V).then(r => r.json()),
    fetch("data/grid500.geojson?v=" + DATA_V).then(r => r.json()),
    fetch("data/subway.geojson?v=" + DATA_V).then(r => r.json()),
    fetch("data/stats_by_district.json?v=" + DATA_V).then(r => r.json()),
  ]);
  FAC = fac; STATS = statsJ.stats;

  // 자치구 경계 + 통계 병합(단계구분도용)
  const statByGu = Object.fromEntries(STATS.map(s => [s.자치구, s]));
  districts.features.forEach(f => {
    const s = statByGu[f.properties.name] || {};
    Object.assign(f.properties, {
      시설수: s.시설수 || 0, 인구1만명당: s.인구1만명당 || 0, 면적1km2당: s.면적1km2당 || 0,
    });
  });

  map.addSource("districts", { type: "geojson", data: districts });
  map.addSource("facilities", { type: "geojson", data: fac });
  map.addSource("grid", { type: "geojson", data: grid });
  map.addSource("subway", { type: "geojson", data: subway });

  // ----- 자치구 단계구분도 (분석 모드) -----
  map.addLayer({
    id: "choro", type: "fill", source: "districts",
    layout: { visibility: "none" },
    paint: { "fill-color": "#ccc", "fill-opacity": 0.55 },
  }, firstSymbolId());

  // ----- 500m 격자 밀도 -----
  map.addLayer({
    id: "grid-density", type: "fill", source: "grid",
    layout: { visibility: "none" },
    filter: [">", ["get", "count"], 0],
    paint: {
      "fill-color": ["interpolate", ["linear"], ["get", "count"],
        1, "#fdf6ec", 2, "#f2c057", 5, "#c94f30", 12, "#701f28"],
      "fill-opacity": 0.6,
    },
  }, firstSymbolId());

  // ----- 문화소외 후보 격자 -----
  map.addLayer({
    id: "underserved", type: "fill", source: "grid",
    layout: { visibility: "none" },
    filter: ["==", ["get", "underserved"], 1],
    paint: { "fill-color": "#2c3e70", "fill-opacity": 0.42 },
  }, firstSymbolId());

  // ----- 자치구 경계선 + 라벨 -----
  map.addLayer({
    id: "gu-line", type: "line", source: "districts",
    paint: { "line-color": "#4a4f58", "line-width": 1.1, "line-dasharray": [3, 2], "line-opacity": 0.8 },
  });
  map.addLayer({
    id: "gu-label", type: "symbol", source: "districts",
    layout: { "text-field": ["get", "name"], "text-size": 12, "text-font": ["Noto Sans Bold"] },
    paint: { "text-color": "#3a3f47", "text-halo-color": "#ffffff", "text-halo-width": 1.4 },
    minzoom: 9, maxzoom: 13,
  });

  // ----- 지하철역 -----
  map.addLayer({
    id: "subway-pt", type: "circle", source: "subway",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 1.6, 14, 4],
      "circle-color": "#ffffff", "circle-stroke-color": "#00652e", "circle-stroke-width": 1.6,
    },
  });
  map.addLayer({
    id: "subway-label", type: "symbol", source: "subway", minzoom: 13.5,
    layout: { "text-field": ["get", "name"], "text-size": 10, "text-offset": [0, 1], "text-anchor": "top", "text-font": ["Noto Sans Regular"] },
    paint: { "text-color": "#00652e", "text-halo-color": "#fff", "text-halo-width": 1 },
  });

  // ----- 커널 밀도(열지도) -----
  map.addLayer({
    id: "heat", type: "heatmap", source: "facilities",
    layout: { visibility: "none" },
    paint: {
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 9, 14, 14, 36],
      "heatmap-intensity": 0.7, "heatmap-opacity": 0.55,
      "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
        0, "rgba(255,255,255,0)", 0.25, "#fdebd0", 0.5, "#f5b041", 0.75, "#dc7633", 1, "#922b21"],
    },
  });

  // ----- 시설 지점(유형별 색) -----
  const colorExpr = ["match", ["get", "유형"]];
  TYPES.forEach(t => { colorExpr.push(t, TYPE_COLORS[t]); });
  colorExpr.push("#888");

  map.addLayer({
    id: "fac-pt", type: "circle", source: "facilities",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 2.2, 12, 4, 16, 8],
      "circle-color": colorExpr,
      "circle-stroke-color": "#ffffff", "circle-stroke-width": 1,
      "circle-opacity": 0.92,
    },
  });
  map.addLayer({
    id: "fac-label", type: "symbol", source: "facilities", minzoom: 14,
    layout: {
      "text-field": ["get", "시설명"], "text-size": 10.5,
      "text-offset": [0, 1.1], "text-anchor": "top", "text-font": ["Noto Sans Regular"],
      "text-optional": true,
    },
    paint: { "text-color": "#2c2f36", "text-halo-color": "#ffffff", "text-halo-width": 1.3 },
  });

  // ----- 팝업 -----
  map.on("click", "fac-pt", e => {
    const p = e.features[0].properties;
    const rows = [
      ["유형", p.유형], ["자치구", p.자치구], ["주소", p.주소],
      ["운영주체", p.운영주체], ["공공·민간", p.공공민간], ["설립구분", p.설립구분],
      ["설립연도", p.설립연도], ["입장료", p.입장료], ["휠체어 접근", p.휠체어접근],
      ["운영상태", p.운영상태],
      ["최근접 지하철역", `${p.최근접지하철역} (직선 ${p.지하철역거리m_직선}m)`],
      ["웹사이트", p.웹사이트 !== "자료 없음" ? `<a href="${p.웹사이트}" target="_blank">바로가기</a>` : "자료 없음"],
      ["데이터", `${p.데이터출처} · ${p.데이터기준일}`],
    ];
    const html = `<div class="pop"><h3>${p.시설명}</h3>
      <div class="ptype">${p.영문명 !== "자료 없음" ? p.영문명 : ""}</div>
      <table>${rows.map(([k, v]) =>
        `<tr><td>${k}</td><td class="${String(v).includes("자료 없음") ? "na" : ""}">${v}</td></tr>`).join("")}
      </table></div>`;
    new maplibregl.Popup({ closeButton: true }).setLngLat(e.lngLat).setHTML(html).addTo(map);
  });
  map.on("mouseenter", "fac-pt", () => map.getCanvas().style.cursor = "pointer");
  map.on("mouseleave", "fac-pt", () => map.getCanvas().style.cursor = "");

  // 격자 클릭 → 밀도/최근접 거리
  map.on("click", "underserved", e => {
    const p = e.features[0].properties;
    new maplibregl.Popup().setLngLat(e.lngLat)
      .setHTML(`<b>문화소외 후보 격자</b><br>자치구: ${p.gu}<br>셀 내 시설: ${p.count}개<br>최근접 시설: 직선 ${p.nearest_m}m<br><span style="color:#888;font-size:10px">기준: 최근접 문화시설 직선거리 800m 초과(근사 지표)</span>`)
      .addTo(map);
  });

  buildUI();
  applyFilter();
}

function firstSymbolId() {
  const layers = map.getStyle().layers;
  const s = layers.find(l => l.type === "symbol");
  return s ? s.id : undefined;
}

// ---------- UI 구축 ----------
const state = { types: new Set(TYPES), gu: "", pub: "", q: "" };

function buildUI() {
  // 유형 체크박스
  const tl = document.getElementById("typelist");
  const counts = {};
  FAC.features.forEach(f => counts[f.properties.유형] = (counts[f.properties.유형] || 0) + 1);
  TYPES.filter(t => counts[t]).forEach(t => {
    const lb = document.createElement("label");
    lb.innerHTML = `<input type="checkbox" checked data-type="${t}"><span class="swatch" style="background:${TYPE_COLORS[t]}"></span>${t} <span class="cnt">${counts[t]}</span>`;
    lb.querySelector("input").addEventListener("change", ev => {
      ev.target.checked ? state.types.add(t) : state.types.delete(t);
      applyFilter();
    });
    tl.appendChild(lb);
  });
  document.getElementById("type-all").onclick = () => { state.types = new Set(TYPES); tl.querySelectorAll("input").forEach(i => i.checked = true); applyFilter(); };
  document.getElementById("type-none").onclick = () => { state.types.clear(); tl.querySelectorAll("input").forEach(i => i.checked = false); applyFilter(); };

  // 자치구 셀렉트
  const gsel = document.getElementById("f-gu");
  GUS.forEach(g => gsel.add(new Option(g, g)));
  gsel.onchange = () => { state.gu = gsel.value; applyFilter(); };
  document.getElementById("f-pub").onchange = e => { state.pub = e.target.value; applyFilter(); };
  document.getElementById("q").oninput = e => { state.q = e.target.value.trim(); applyFilter(); };

  // 범례
  const lb = document.getElementById("legend-body");
  lb.innerHTML = TYPES.filter(t => counts[t]).map(t =>
    `<div class="li"><span class="swatch" style="background:${TYPE_COLORS[t]}"></span>${t}</div>`).join("");

  // 모드
  document.getElementById("btn-real").onclick = () => setMode("real");
  document.getElementById("btn-analysis").onclick = () => setMode("analysis");
  document.getElementById("btn-night").onclick = e => {
    document.getElementById("map").classList.toggle("night");
    e.target.classList.toggle("on");
  };

  // 분석 레이어 토글
  const tie = (id, layers) => document.getElementById(id).addEventListener("change", e =>
    layers.forEach(l => map.setLayoutProperty(l, "visibility", e.target.checked ? "visible" : "none")));
  tie("l-heat", ["heat"]);
  tie("l-grid", ["grid-density"]);
  tie("l-underserved", ["underserved"]);
  tie("l-subway", ["subway-pt", "subway-label"]);
  tie("l-boundary", ["gu-line", "gu-label"]);
  document.getElementById("l-choro").addEventListener("change", e => {
    map.setLayoutProperty("choro", "visibility", e.target.checked ? "visible" : "none");
    updateChoro();
  });
  document.getElementById("choro-metric").addEventListener("change", updateChoro);

  // 슬라이더
  document.getElementById("terrain-ex").oninput = e =>
    map.setTerrain({ source: "dem", exaggeration: +e.target.value });
  document.getElementById("bld-op").oninput = e =>
    extrusionLayers.forEach(l => map.setPaintProperty(l, "fill-extrusion-opacity", +e.target.value));
  document.getElementById("icon-size").oninput = e => {
    const k = +e.target.value;
    map.setPaintProperty("fac-pt", "circle-radius",
      ["interpolate", ["linear"], ["zoom"], 9, 2.2 * k, 12, 4 * k, 16, 8 * k]);
    map.setLayoutProperty("fac-pt", "visibility", k === 0 ? "none" : "visible");
  };

  // 장면
  document.querySelectorAll(".scene-btn").forEach(btn => btn.onclick = () => {
    const s = SCENES[+btn.dataset.scene];
    map.flyTo({ center: s.c, zoom: s.z, pitch: s.p, bearing: s.b, duration: 2600 });
    if (s.underserved) {
      setMode("analysis");
      ["l-underserved", "l-choro"].forEach(id => { const el = document.getElementById(id); if (!el.checked) { el.checked = true; el.dispatchEvent(new Event("change")); } });
    }
  });

  // 통계 패널
  document.getElementById("btn-stats").onclick = toggleStats;

  // 비교
  const ca = document.getElementById("cmp-a"), cb = document.getElementById("cmp-b");
  GUS.forEach(g => { ca.add(new Option(g, g)); cb.add(new Option(g, g)); });
  ca.value = "강남구"; cb.value = "도봉구";
  document.getElementById("btn-compare").onclick = () => {
    document.getElementById("compare-modal").style.display = "block";
    renderCompare();
  };
  ca.onchange = renderCompare; cb.onchange = renderCompare;

  // 다운로드
  document.getElementById("dl-geojson").onclick = () => download("seoul_cultural_facilities_filtered.geojson",
    JSON.stringify({ type: "FeatureCollection", metadata: FAC.metadata, features: filteredFeatures() }, null, 1), "application/geo+json");
  document.getElementById("dl-csv").onclick = () => {
    const fs = filteredFeatures();
    if (!fs.length) return;
    const keys = Object.keys(fs[0].properties);
    const esc = v => `"${String(v).replace(/"/g, '""')}"`;
    const csv = "﻿" + keys.join(",") + "\n" + fs.map(f => keys.map(k => esc(f.properties[k])).join(",")).join("\n");
    download("seoul_cultural_facilities_filtered.csv", csv, "text/csv");
  };
}

function setMode(m) {
  mode = m;
  document.getElementById("btn-real").classList.toggle("on", m === "real");
  document.getElementById("btn-analysis").classList.toggle("on", m === "analysis");
  const analysisChecks = ["l-heat", "l-grid", "l-underserved", "l-choro"];
  if (m === "real") {
    analysisChecks.forEach(id => { const el = document.getElementById(id); el.checked = false; el.dispatchEvent(new Event("change")); });
    map.setPaintProperty("fac-pt", "circle-opacity", 0.92);
    document.getElementById("legend-title").textContent = "시설 유형";
  } else {
    const el = document.getElementById("l-heat"); el.checked = true; el.dispatchEvent(new Event("change"));
    document.getElementById("legend-title").textContent = "분석 모드 — 시설 유형 · 밀도";
  }
}

// ---------- 필터 ----------
function filterExpr() {
  const conds = ["all"];
  conds.push(["in", ["get", "유형"], ["literal", [...state.types]]]);
  if (state.gu) conds.push(["==", ["get", "자치구"], state.gu]);
  if (state.pub) conds.push(["in", state.pub, ["get", "공공민간"]]);
  if (state.q) conds.push([">=", ["index-of", state.q, ["get", "시설명"]], 0]);
  return conds;
}
function applyFilter() {
  if (!map.getLayer("fac-pt")) return;
  const f = filterExpr();
  ["fac-pt", "fac-label", "heat"].forEach(l => map.setFilter(l, f));
  document.getElementById("filter-count").textContent =
    `표시 중: ${filteredFeatures().length}개소 / 전체 ${FAC.features.length}개소`;
}
function filteredFeatures() {
  return FAC.features.filter(f => {
    const p = f.properties;
    if (!state.types.has(p.유형)) return false;
    if (state.gu && p.자치구 !== state.gu) return false;
    if (state.pub && !String(p.공공민간).includes(state.pub)) return false;
    if (state.q && !p.시설명.includes(state.q)) return false;
    return true;
  });
}

// ---------- 단계구분도 ----------
function updateChoro() {
  const metric = document.getElementById("choro-metric").value;
  const vals = STATS.map(s => s[metric]);
  const max = Math.max(...vals);
  map.setPaintProperty("choro", "fill-color",
    ["interpolate", ["linear"], ["get", metric],
      0, "#f4f6f8", max * 0.25, "#c6dbef", max * 0.5, "#6baed6", max * 0.75, "#2b7bba", max, "#0b3d66"]);
  document.getElementById("legend-title").textContent = `단계구분도: ${metric}`;
}

// ---------- 통계 패널 ----------
function toggleStats() {
  const box = document.getElementById("statsbox");
  if (box.style.display === "block") { box.style.display = "none"; return; }
  const typeCounts = {};
  FAC.features.forEach(f => typeCounts[f.properties.유형] = (typeCounts[f.properties.유형] || 0) + 1);
  const sortedTypes = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
  const maxT = sortedTypes[0][1];
  const top = [...STATS].sort((a, b) => b.시설수 - a.시설수);
  const maxG = top[0].시설수;
  box.innerHTML = `
    <h2>유형별 시설 수 (전체 ${FAC.features.length}개소)</h2>
    ${sortedTypes.map(([t, n]) => `<div class="barrow"><span>${t}</span><div class="bar" style="width:${n / maxT * 100}%;background:${TYPE_COLORS[t] || '#888'}"></div><span style="text-align:right">${n}</span></div>`).join("")}
    <h2 style="margin-top:14px">자치구별 시설 수</h2>
    ${top.map(s => `<div class="barrow"><span>${s.자치구}</span><div class="bar" style="width:${s.시설수 / maxG * 100}%"></div><span style="text-align:right">${s.시설수}</span></div>`).join("")}
    <h2 style="margin-top:14px">공급 지표 상·하위</h2>
    <table><tr><th>자치구</th><th>시설수</th><th>1만명당</th><th>㎢당</th></tr>
    ${[...top.slice(0, 5), ...top.slice(-5)].map(s =>
      `<tr><td>${s.자치구}</td><td>${s.시설수}</td><td>${s.인구1만명당}</td><td>${s.면적1km2당}</td></tr>`).join("")}
    </table>
    <div class="hint" style="margin-top:8px">인구 1만명당 지표의 인구는 주민등록인구 근사치(2024년 기준, 확인 필요)를 사용. 시설 수는 OSM 2026-07 기준.</div>`;
  box.style.display = "block";
}

// ---------- 비교 ----------
function renderCompare() {
  const a = STATS.find(s => s.자치구 === document.getElementById("cmp-a").value);
  const b = STATS.find(s => s.자치구 === document.getElementById("cmp-b").value);
  if (!a || !b) return;
  const rows = [
    ["시설 수", "시설수"], ["인구(참고치)", "인구_참고치"], ["면적(㎢)", "면적km2"],
    ["인구 1만명당", "인구1만명당"], ["면적 1㎢당", "면적1km2당"],
    ["공공(추정 포함)", "공공"], ["민간(추정)", "민간"],
    ["미술관", "미술관"], ["박물관", "박물관"], ["갤러리·전시공간", "갤러리·전시공간"],
    ["공연장", "공연장"], ["공공도서관", "공공도서관"], ["복합문화공간", "복합문화공간"],
    ["영화관·시네마테크", "영화관·시네마테크"], ["궁궐·전통문화시설", "궁궐·전통문화시설"],
  ];
  document.getElementById("cmp-result").innerHTML =
    `<table><tr><th>지표</th><th>${a.자치구}</th><th>${b.자치구}</th></tr>` +
    rows.map(([lb, k]) => `<tr><td>${lb}</td><td>${(a[k] ?? 0).toLocaleString()}</td><td>${(b[k] ?? 0).toLocaleString()}</td></tr>`).join("") +
    `</table><div class="hint" style="margin-top:6px">시설 수: OSM 2026-07 기준 · 인구: 주민등록인구 근사치(2024, 확인 필요)</div>`;
}

// ---------- 다운로드 ----------
function download(name, content, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
