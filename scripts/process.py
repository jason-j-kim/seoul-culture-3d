# -*- coding: utf-8 -*-
"""
서울 문화시설 3D 연구 플랫폼 - 데이터 처리 파이프라인
입력: OSM Overpass 원자료 (raw_facilities.json, raw_subway.json), 자치구 경계 (districts.geojson)
출력: facilities.geojson/csv, subway.geojson, stats_by_district.json/csv, grid500.geojson
좌표계: WGS84 (EPSG:4326)
데이터 기준일: OSM 2026-07-02 스냅숏
"""
import json, math, csv, io, sys, re
from collections import defaultdict

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

BASE = r"C:\Users\user\Desktop\관장서류추가\seoul-culture-3d"

# ---------- 자치구 참고 통계 (면적: 공식 행정구역 면적, 인구: 주민등록인구 근사치 2024 — '참고치, 확인 필요') ----------
DISTRICT_REF = {
    "종로구": {"pop": 149000, "area": 23.91}, "중구": {"pop": 131000, "area": 9.96},
    "용산구": {"pop": 217000, "area": 21.87}, "성동구": {"pop": 281000, "area": 16.86},
    "광진구": {"pop": 339000, "area": 17.06}, "동대문구": {"pop": 358000, "area": 14.22},
    "중랑구": {"pop": 385000, "area": 18.50}, "성북구": {"pop": 435000, "area": 24.58},
    "강북구": {"pop": 289000, "area": 23.60}, "도봉구": {"pop": 306000, "area": 20.65},
    "노원구": {"pop": 496000, "area": 35.44}, "은평구": {"pop": 465000, "area": 29.71},
    "서대문구": {"pop": 318000, "area": 17.63}, "마포구": {"pop": 372000, "area": 23.85},
    "양천구": {"pop": 434000, "area": 17.41}, "강서구": {"pop": 562000, "area": 41.44},
    "구로구": {"pop": 411000, "area": 20.12}, "금천구": {"pop": 239000, "area": 13.02},
    "영등포구": {"pop": 397000, "area": 24.55}, "동작구": {"pop": 380000, "area": 16.35},
    "관악구": {"pop": 486000, "area": 29.57}, "서초구": {"pop": 413000, "area": 46.98},
    "강남구": {"pop": 561000, "area": 39.50}, "송파구": {"pop": 655000, "area": 33.88},
    "강동구": {"pop": 460000, "area": 24.59},
}

# ---------- 유틸 ----------
def haversine(lon1, lat1, lon2, lat2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*R*math.asin(math.sqrt(a))

def point_in_ring(lon, lat, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > lat) != (yj > lat)) and (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside

def point_in_polygon(lon, lat, geom):
    if geom["type"] == "Polygon":
        polys = [geom["coordinates"]]
    else:
        polys = geom["coordinates"]
    for poly in polys:
        if point_in_ring(lon, lat, poly[0]):
            holed = any(point_in_ring(lon, lat, hole) for hole in poly[1:])
            if not holed:
                return True
    return False

# ---------- 경계 로드 ----------
with open(f"{BASE}/data/districts.geojson", encoding="utf-8") as f:
    districts = json.load(f)

def find_district(lon, lat):
    for feat in districts["features"]:
        if point_in_polygon(lon, lat, feat["geometry"]):
            return feat["properties"]["name"]
    return None

# ---------- 지하철역 ----------
with open(f"{BASE}/data/raw_subway.json", encoding="utf-8") as f:
    raw_sub = json.load(f)

stations = []
seen_st = set()
for el in raw_sub["elements"]:
    t = el.get("tags", {})
    name = t.get("name")
    if not name:
        continue
    lon = el.get("lon") or el.get("center", {}).get("lon")
    lat = el.get("lat") or el.get("center", {}).get("lat")
    if lon is None:
        continue
    key = (name, round(lon, 3), round(lat, 3))
    if key in seen_st:
        continue
    seen_st.add(key)
    stations.append({"name": name, "lon": lon, "lat": lat})
print("지하철역(중복제거):", len(stations))

def nearest_station(lon, lat):
    best, bd = None, 1e12
    for s in stations:
        d = haversine(lon, lat, s["lon"], s["lat"])
        if d < bd:
            bd, best = d, s
    return best["name"], round(bd)

# ---------- 문화시설 분류 ----------
def classify(tags):
    name = tags.get("name", "")
    tourism = tags.get("tourism", "")
    amenity = tags.get("amenity", "")
    historic = tags.get("historic", "")
    if historic in ("palace", "castle"):
        return "궁궐·전통문화시설"
    if historic in ("city_gate", "fort"):
        return "역사유적·문화재"
    if historic in ("monument", "memorial"):
        return "기념관·기념물"
    if tourism == "museum":
        if "미술관" in name or re.search(r"art museum", name, re.I):
            return "미술관"
        return "박물관"
    if tourism == "gallery":
        if "미술관" in name:
            return "미술관"
        return "갤러리·전시공간"
    if amenity == "arts_centre":
        return "복합문화공간"
    if amenity == "theatre":
        if "국악" in name:
            return "국악공연시설"
        if "콘서트" in name or "체임버" in name:
            return "콘서트홀"
        return "공연장"
    if amenity == "music_venue":
        return "콘서트홀"
    if amenity == "cinema":
        return "영화관·시네마테크"
    if amenity == "library":
        if "작은도서관" in name:
            return "작은도서관"
        return "공공도서관"
    if amenity == "planetarium":
        return "과학문화시설"
    if amenity == "community_centre":
        return "문화원·지역문화센터"
    return None

PUBLIC_PAT = re.compile(r"국립|시립|구립|도립|서울특별시|문화체육관광부|교육청|공단|공사|재단|주민센터|문화원")
def ownership(tags):
    name = tags.get("name", "")
    op = tags.get("operator", "") or tags.get("owner", "")
    joined = name + " " + op
    if re.search(r"국립|National Museum", joined):
        return "공공", "국립(추정)"
    if re.search(r"서울특별시|시립", joined):
        return "공공", "시립(추정)"
    if re.search(r"구립|구청|교육청", joined):
        return "공공", "구립·교육청(추정)"
    if PUBLIC_PAT.search(joined):
        return "공공(추정)", "확인 필요"
    if op:
        return "민간(추정)", "민간(추정)"
    return "확인 필요", "확인 필요"

def build_address(tags):
    parts = []
    for k in ("addr:province", "addr:city", "addr:district", "addr:street", "addr:housenumber"):
        if tags.get(k):
            parts.append(tags[k])
    if tags.get("addr:full"):
        return tags["addr:full"]
    return " ".join(parts) if parts else "자료 없음"

with open(f"{BASE}/data/raw_facilities.json", encoding="utf-8") as f:
    raw = json.load(f)

osm_ts = raw.get("osm3s", {}).get("timestamp_osm_base", "")

items = []
for el in raw["elements"]:
    tags = el.get("tags", {})
    name = tags.get("name")
    if not name:
        continue
    cat = classify(tags)
    if not cat:
        continue
    lon = el.get("lon") or el.get("center", {}).get("lon")
    lat = el.get("lat") or el.get("center", {}).get("lat")
    if lon is None:
        continue
    items.append({"el": el, "tags": tags, "name": name.strip(), "cat": cat, "lon": lon, "lat": lat,
                  "otype": el["type"]})

# 중복 제거: 동일 정규화 명칭 + 300m 이내 → way/relation(건물 윤곽) 우선
def normname(s):
    return re.sub(r"\s+", "", s)

groups = defaultdict(list)
for it in items:
    groups[normname(it["name"])].append(it)

deduped = []
for nm, grp in groups.items():
    grp.sort(key=lambda x: {"relation": 0, "way": 1, "node": 2}[x["otype"]])
    kept = []
    for it in grp:
        dup = any(haversine(it["lon"], it["lat"], k["lon"], k["lat"]) < 300 for k in kept)
        if not dup:
            kept.append(it)
    deduped.extend(kept)
print("시설(이름 있음, 분류됨):", len(items), "→ 중복제거 후:", len(deduped))

# 속성 구축
features = []
rows = []
for i, it in enumerate(deduped):
    tags = it["tags"]
    gu = find_district(it["lon"], it["lat"])
    if gu is None:
        continue  # 서울 경계 밖(경계 오차) 제외
    st_name, st_dist = nearest_station(it["lon"], it["lat"])
    pub, level = ownership(tags)
    props = {
        "id": f"F{i:05d}",
        "시설명": it["name"],
        "영문명": tags.get("name:en", "자료 없음"),
        "유형": it["cat"],
        "세부장르": tags.get("theatre:genre", tags.get("museum", "자료 없음")),
        "주소": build_address(tags),
        "자치구": gu,
        "위도": round(it["lat"], 6),
        "경도": round(it["lon"], 6),
        "운영주체": tags.get("operator", "자료 없음"),
        "공공민간": pub,
        "설립구분": level,
        "설립연도": tags.get("start_date", "자료 없음"),
        "웹사이트": tags.get("website", tags.get("contact:website", "자료 없음")),
        "전화": tags.get("phone", tags.get("contact:phone", "자료 없음")),
        "입장료": tags.get("fee", "자료 없음"),
        "휠체어접근": tags.get("wheelchair", "자료 없음"),
        "운영상태": "폐업(OSM disused)" if any(k.startswith("disused") for k in tags) else "운영 중(추정)",
        "최근접지하철역": st_name,
        "지하철역거리m_직선": st_dist,
        "데이터출처": "OpenStreetMap (ODbL)",
        "데이터기준일": osm_ts[:10] if osm_ts else "확인 필요",
        "데이터신뢰도": "커뮤니티 지도 기반 — 개별 검증 필요",
        "osm_id": f"{it['otype']}/{it['el']['id']}",
    }
    features.append({"type": "Feature",
                     "geometry": {"type": "Point", "coordinates": [round(it["lon"], 6), round(it["lat"], 6)]},
                     "properties": props})
    rows.append(props)

print("서울 경계 내 최종 시설 수:", len(features))

fc = {"type": "FeatureCollection",
      "metadata": {"source": "OpenStreetMap via Overpass API", "license": "ODbL",
                   "osm_timestamp": osm_ts, "crs": "EPSG:4326",
                   "note": "시설 속성 중 OSM에 없는 항목은 '자료 없음'으로 표기. 지하철역 거리는 직선거리(네트워크 거리 아님)."},
      "features": features}
with open(f"{BASE}/data/facilities.geojson", "w", encoding="utf-8") as f:
    json.dump(fc, f, ensure_ascii=False)

# CSV
with open(f"{BASE}/output/facilities.csv", "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)

# 지하철 GeoJSON
sub_fc = {"type": "FeatureCollection", "features": [
    {"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(s["lon"],6), round(s["lat"],6)]},
     "properties": {"name": s["name"]}} for s in stations]}
with open(f"{BASE}/data/subway.geojson", "w", encoding="utf-8") as f:
    json.dump(sub_fc, f, ensure_ascii=False)

# ---------- 자치구별 통계 ----------
by_gu = defaultdict(lambda: defaultdict(int))
for r in rows:
    by_gu[r["자치구"]]["총계"] += 1
    by_gu[r["자치구"]][r["유형"]] += 1
    if r["공공민간"].startswith("공공"):
        by_gu[r["자치구"]]["공공"] += 1
    elif r["공공민간"].startswith("민간"):
        by_gu[r["자치구"]]["민간"] += 1

stats = []
for gu, ref in DISTRICT_REF.items():
    c = by_gu.get(gu, {})
    total = c.get("총계", 0)
    stats.append({
        "자치구": gu, "시설수": total,
        "인구_참고치": ref["pop"], "면적km2": ref["area"],
        "인구1만명당": round(total / ref["pop"] * 10000, 2),
        "면적1km2당": round(total / ref["area"], 2),
        "공공": c.get("공공", 0), "민간": c.get("민간", 0),
        **{cat: c.get(cat, 0) for cat in sorted({r["유형"] for r in rows})}
    })
stats.sort(key=lambda x: -x["시설수"])
with open(f"{BASE}/data/stats_by_district.json", "w", encoding="utf-8") as f:
    json.dump({"note": "인구는 주민등록인구 근사치(2024년 기준, 확인 필요). 시설 수는 OSM 기반.",
               "stats": stats}, f, ensure_ascii=False, indent=1)
with open(f"{BASE}/output/stats_by_district.csv", "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(stats[0].keys()))
    w.writeheader()
    w.writerows(stats)

# ---------- 500m 격자 밀도 + 문화소외(직선거리 800m 근사) ----------
lons = [f["geometry"]["coordinates"][0] for f in features]
lats = [f["geometry"]["coordinates"][1] for f in features]
minlon, maxlon = 126.76, 127.19
minlat, maxlat = 37.41, 37.72
lat0 = 37.55
dlat = 500 / 111320.0
dlon = 500 / (111320.0 * math.cos(math.radians(lat0)))

# 시설 위치를 격자 인덱스에 버킷화(최근접 탐색 가속)
def cell_of(lon, lat):
    return (int((lon - minlon) / dlon), int((lat - minlat) / dlat))

bucket = defaultdict(list)
for f_ in features:
    lo, la = f_["geometry"]["coordinates"]
    bucket[cell_of(lo, la)].append((lo, la))

grid_feats = []
ny = int((maxlat - minlat) / dlat) + 1
nx = int((maxlon - minlon) / dlon) + 1
for iy in range(ny):
    for ix in range(nx):
        clon = minlon + (ix + 0.5) * dlon
        clat = minlat + (iy + 0.5) * dlat
        gu = find_district(clon, clat)
        if gu is None:
            continue
        cnt = len(bucket.get((ix, iy), []))
        # 최근접 시설 거리(주변 3km 탐색)
        best = 1e12
        rng = 7
        for jy in range(iy - rng, iy + rng + 1):
            for jx in range(ix - rng, ix + rng + 1):
                for (lo, la) in bucket.get((jx, jy), []):
                    d = haversine(clon, clat, lo, la)
                    if d < best:
                        best = d
        neardist = round(best) if best < 1e11 else 99999
        grid_feats.append({"type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [[
                [minlon + ix*dlon, minlat + iy*dlat], [minlon + (ix+1)*dlon, minlat + iy*dlat],
                [minlon + (ix+1)*dlon, minlat + (iy+1)*dlat], [minlon + ix*dlon, minlat + (iy+1)*dlat],
                [minlon + ix*dlon, minlat + iy*dlat]]]},
            "properties": {"gu": gu, "count": cnt, "nearest_m": neardist,
                           "underserved": 1 if neardist > 800 else 0}})

with open(f"{BASE}/data/grid500.geojson", "w", encoding="utf-8") as f:
    json.dump({"type": "FeatureCollection",
               "metadata": {"cell": "약 500m 격자(위경도 근사)", "underserved 기준": "최근접 문화시설 직선거리 800m 초과(네트워크 거리 아님, 근사 지표)"},
               "features": grid_feats}, f, ensure_ascii=False)

print("격자 셀:", len(grid_feats), "| 문화소외 후보 셀:", sum(g["properties"]["underserved"] for g in grid_feats))
print("유형별:", json.dumps(sorted(((c, sum(1 for r in rows if r['유형']==c)) for c in {r['유형'] for r in rows}), key=lambda x:-x[1]), ensure_ascii=False))
