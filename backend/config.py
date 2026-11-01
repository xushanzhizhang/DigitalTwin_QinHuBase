# -*- coding: utf-8 -*-
"""
琴湖基地智慧农业数字孪生 —— 全局配置（单一事实来源）

本文件定义：
  1. 坐标系与场地范围          —— 前后端共用，保证孪生体与模型空间一致
  2. 五大功能分区（Zone）       —— 对应实地四部分 + 露地苗床区
  3. 传感器布点（SensorNode）   —— 每个节点的位置、指标集合、设备能力
  4. 作物农艺参数（Crop）       —— 模拟器与决策 Agent 共用的知识基准
  5. 控制设备（Actuator）       —— 通风、遮阳、补光、滴灌、加温、湿帘

坐标系约定（与前端 Three.js 完全一致）：
    +X = 东          -X = 西
    +Y = 天（高程）  场地设计标高 41.60 ~ 41.73 m（南低北高）
    +Z = 南          -Z = 北
    单位：米
    原点位于基地几何中心。
"""

from __future__ import annotations

# =============================================================================
# 一、场地与坐标系
# =============================================================================

SITE = {
    "name": "徐州生物工程职业技术学院 · 琴湖基地（农林实训基地）",
    "short_name": "琴湖基地",
    # 场地外轮廓（矩形，东西 230 m × 南北 170 m）
    "extent_x": (-115.0, 115.0),
    "extent_z": (-85.0, 85.0),
    # 设计标高：南端 41.60，北端 41.73（据图1 高程点）
    "elev_south": 41.60,
    "elev_north": 41.73,
    # 地理坐标（用于太阳位置精确计算的纬度，徐州）
    "latitude": 34.26,
    "longitude": 117.18,
    # 时区
    "tz_offset": 8.0,
}

# =============================================================================
# 二、作物农艺参数
# =============================================================================
# 说明：
#   vwc  —— 土壤体积含水率（Volumetric Water Content，%）
#   kc   —— 作物系数，用于 ETc = Kc × ET0
#   dli  —— 每日光积分目标（Daily Light Integral, mol/m²/d）
#   以下数值取自常见设施栽培栽培技术规程的工程取值范围，用于模拟与决策阈值。

CROPS = {
    "peony": {
        "name": "芍药",
        "latin": "Paeonia lactiflora",
        "note": "徐州为国内重要芍药种苗产区，基地第三部分为其种质资源创新基地",
        "temp": {"opt_min": 15.0, "opt_max": 25.0, "night_min": 5.0, "night_max": 15.0,
                 "abs_min": 2.0, "abs_max": 32.0},
        "vpd": {"opt_min": 0.4, "opt_max": 1.1},
        "vwc": {"lower": 22.0, "upper": 30.0, "field_capacity": 30.0, "wilting": 12.0, "mad": 0.45},
        "ph": {"min": 6.0, "max": 7.2},
        "ec": {"min": 0.8, "max": 1.8},
        "kc": 0.85,
        "root_depth_m": 0.30,
        "dli_target": 16.0,
        "par_saturation": 900.0,
        "co2_opt": 600.0,
        "color": "#e8a0c8",          # 芍药粉
    },
    "tomato": {
        "name": "番茄",
        "latin": "Solanum lycopersicum",
        "note": "园艺植物生产实训中心主栽品种",
        "temp": {"opt_min": 20.0, "opt_max": 28.0, "night_min": 12.0, "night_max": 18.0,
                 "abs_min": 10.0, "abs_max": 35.0},
        "vpd": {"opt_min": 0.5, "opt_max": 1.3},
        "vwc": {"lower": 26.0, "upper": 36.0, "field_capacity": 36.0, "wilting": 14.0, "mad": 0.45},
        "ph": {"min": 6.0, "max": 6.8},
        "ec": {"min": 2.0, "max": 3.5},
        "kc": 1.10,
        "root_depth_m": 0.35,
        "dli_target": 22.0,
        "par_saturation": 1200.0,
        "co2_opt": 800.0,
        "color": "#e2574c",          # 番茄红
    },
    "strawberry": {
        "name": "草莓",
        "latin": "Fragaria × ananassa",
        "note": "数智农业实践研学中心高架栽培",
        "temp": {"opt_min": 18.0, "opt_max": 24.0, "night_min": 8.0, "night_max": 15.0,
                 "abs_min": 5.0, "abs_max": 30.0},
        "vpd": {"opt_min": 0.4, "opt_max": 1.0},
        "vwc": {"lower": 29.0, "upper": 40.0, "field_capacity": 40.0, "wilting": 16.0, "mad": 0.45},
        "ph": {"min": 5.5, "max": 6.5},
        "ec": {"min": 1.0, "max": 1.8},
        "kc": 0.90,
        "root_depth_m": 0.20,
        "dli_target": 17.0,
        "par_saturation": 800.0,
        "co2_opt": 700.0,
        "color": "#ef4b6a",
    },
    "leafy": {
        "name": "叶菜（水培）",
        "latin": "Lactuca sativa",
        "note": "数智中心水培区 / 露地苗床",
        "temp": {"opt_min": 15.0, "opt_max": 22.0, "night_min": 10.0, "night_max": 18.0,
                 "abs_min": 4.0, "abs_max": 28.0},
        "vpd": {"opt_min": 0.4, "opt_max": 1.0},
        "vwc": {"lower": 31.0, "upper": 42.0, "field_capacity": 42.0, "wilting": 18.0, "mad": 0.45},
        "ph": {"min": 5.8, "max": 6.5},
        "ec": {"min": 1.2, "max": 2.2},
        "kc": 0.95,
        "root_depth_m": 0.15,
        "dli_target": 14.0,
        "par_saturation": 600.0,
        "co2_opt": 600.0,
        "color": "#5fbf6a",
    },
}

# =============================================================================
# 三、功能分区
# =============================================================================
# 每个分区包含：
#   id / name / part  —— 编号、名称、对应的实地"第 N 部分"
#   kind              —— lake / greenhouse / field
#   crop              —— 主栽作物键（露地/景观区为 None）
#   poly              —— 外轮廓多边形（世界坐标 xz，米）
#   sensor_anchor     —— 环境监测节点位置
#   cameras           —— 推荐视角机位（前端漫游用）

ZONES = {
    "Z1": {
        "id": "Z1",
        "name": "琴湖景观区",
        "part": "第一部分 · 入门正对的湖和桥",
        "kind": "lake",
        "crop": None,
        "description": "西门朝西，进门正对琴湖；湖心有岛，石砌护岸，东西各设桥通达；"
                       "环湖柳树成荫，环湖路串联全园；东侧为「兰汀」水景。",
        "poly": [(-88, -38), (62, -38), (62, 50), (-88, 50)],
        "sensor_anchor": (-20.0, 6.0),
        "cameras": [
            {"name": "西门视角", "pos": [-104, 6, 10], "target": [-40, 2, 6]},
            {"name": "环湖鸟瞰", "pos": [-70, 44, 62], "target": [-8, 0, 6]},
        ],
    },
    "Z2": {
        "id": "Z2",
        "name": "园艺植物生产实训中心",
        "part": "第二部分 · 东北角三连栋",
        "kind": "greenhouse",
        "crop": "tomato",
        "description": "东北角三栋南北走向连栋薄膜温室，尖拱屋面，热镀锌钢管骨架，"
                       "外覆遮阳网桁架，配备卷膜通风、外遮阳、滴灌与水肥一体化。",
        "poly": [(38, -72), (71, -72), (71, -14), (38, -14)],
        "sensor_anchor": (54.5, -43.0),
        "cameras": [
            {"name": "园艺中心正立面", "pos": [54.5, 12, 18], "target": [54.5, 4, -30]},
        ],
    },
    "Z3": {
        "id": "Z3",
        "name": "芍药种质资源创新基地",
        "part": "第三部分 · 三栋东西向棚群",
        "kind": "greenhouse",
        "crop": "peony",
        "description": "西北侧三栋规格一致的东西走向钢架大棚，棚群西端设管理看护房；"
                       "用于芍药种质资源保存、杂交育种与花期调控试验。",
        "poly": [(-92, -78), (-40, -78), (-40, -54), (-92, -54)],
        "sensor_anchor": (-66.0, -66.0),
        "cameras": [
            {"name": "芍药棚群", "pos": [-100, 16, -40], "target": [-66, 3, -66]},
        ],
    },
    "Z4": {
        "id": "Z4",
        "name": "数智农业实践研学中心",
        "part": "第四部分 · 单栋南北向温室",
        "kind": "greenhouse",
        "crop": "strawberry",
        "description": "东南侧单栋南北走向温室，砖砌半墙 + 玻璃围护，东侧中部设主入口"
                       "（绿色弧形雨棚），入口正对兰汀水面；内设高架草莓与水培叶菜研学工位。",
        "poly": [(70, -6), (86, -6), (86, 52), (70, 52)],
        "sensor_anchor": (78.0, 23.0),
        "cameras": [
            {"name": "研学中心入口", "pos": [104, 9, 23], "target": [78, 3.5, 23]},
        ],
    },
    "Z5": {
        "id": "Z5",
        "name": "露地栽培与苗床区",
        "part": "附属 · 露地生产区",
        "kind": "field",
        "crop": "leafy",
        "description": "西南露地畦作区与北部遮阳苗床区，承担种苗繁育与露地栽培实训。",
        "poly": [(-108, 56), (-48, 56), (-48, 80), (-108, 80)],
        "sensor_anchor": (-78.0, 68.0),
        "cameras": [],
    },
}

# 露地苗床补充区（北部遮阳苗床），作为 Z5 的第二块地，仅用于建模与布点
NURSERY_NORTH = {
    "poly": [(-30, -80), (30, -80), (30, -56), (-30, -56)],
    "sensor_anchor": (0.0, -68.0),
}

# =============================================================================
# 四、传感器布点与指标定义
# =============================================================================
# 每个指标：key / label / unit / 合理量程（超出即判为异常或传感器故障）

METRICS = {
    "air_temp":      {"label": "空气温度",   "unit": "°C",        "range": (-20, 60),    "precision": 1},
    "air_humidity":  {"label": "空气相对湿度", "unit": "%",       "range": (0, 100),     "precision": 1},
    "soil_temp":     {"label": "土壤温度",   "unit": "°C",        "range": (-10, 45),    "precision": 1},
    "soil_moisture": {"label": "土壤含水率", "unit": "%",         "range": (0, 60),      "precision": 1},
    "soil_ph":       {"label": "土壤 pH",    "unit": "",          "range": (3, 10),      "precision": 2},
    "soil_ec":       {"label": "土壤 EC",    "unit": "mS/cm",     "range": (0, 8),       "precision": 2},
    "par":           {"label": "光合有效辐射", "unit": "μmol/m²/s", "range": (0, 2500),  "precision": 0},
    "co2":           {"label": "CO₂ 浓度",   "unit": "ppm",       "range": (250, 2000),  "precision": 0},
    "wind_speed":    {"label": "风速",       "unit": "m/s",       "range": (0, 40),      "precision": 1},
    "rainfall":      {"label": "降雨强度",   "unit": "mm/h",      "range": (0, 150),     "precision": 1},
    "water_temp":    {"label": "水温",       "unit": "°C",        "range": (0, 40),      "precision": 1},
    "water_do":      {"label": "溶解氧",     "unit": "mg/L",      "range": (0, 20),      "precision": 2},
    "water_ph":      {"label": "水体 pH",    "unit": "",          "range": (3, 10),      "precision": 2},
}

# 室内环境节点（温室）
GREENHOUSE_METRICS = ["air_temp", "air_humidity", "soil_temp", "soil_moisture",
                      "soil_ph", "soil_ec", "par", "co2"]
# 室外气象站
WEATHER_METRICS = ["air_temp", "air_humidity", "par", "wind_speed", "rainfall", "soil_temp"]
# 水体监测
WATER_METRICS = ["water_temp", "water_do", "water_ph"]


def _node(node_id: str, name: str, zone: str, kind: str, x: float, z: float,
          metrics: list[str], y: float = 1.6) -> dict:
    return {
        "id": node_id,
        "name": name,
        "zone": zone,
        "kind": kind,               # greenhouse / weather / water
        "pos": (x, y, z),
        "metrics": metrics,
        "protocol": "simulated",    # 后续接真实传感器时改为 modbus / mqtt / http
        "online": True,
    }


SENSOR_NODES = [
    _node("SN-Z2-01", "园艺中心 · 环境监测节点",   "Z2", "greenhouse", 70.0, -44.0, GREENHOUSE_METRICS, 2.2),
    _node("SN-Z2-02", "园艺中心 · 根区墒情节点",   "Z2", "greenhouse", 70.0, -76.0, ["soil_temp", "soil_moisture", "soil_ph", "soil_ec"], 0.2),
    _node("SN-Z3-01", "芍药基地 · 环境监测节点",   "Z3", "greenhouse", -80.0, -68.0, GREENHOUSE_METRICS, 2.0),
    _node("SN-Z4-01", "研学中心 · 环境监测节点",   "Z4", "greenhouse", 79.0, 10.0, GREENHOUSE_METRICS, 2.2),
    _node("SN-Z4-02", "研学中心 · 营养液节点",     "Z4", "greenhouse", 79.0, 30.0, ["soil_temp", "soil_moisture", "soil_ph", "soil_ec"], 0.3),
    _node("SN-WX-01", "基地气象站",               "Z1", "weather",   -96.0, 26.0, WEATHER_METRICS, 3.0),
    _node("SN-WT-01", "琴湖水质监测浮标",         "Z1", "water",     -22.0, 26.0, WATER_METRICS, -0.15),
    _node("SN-Z5-01", "露地苗床 · 墒情节点",       "Z5", "greenhouse", -88.0, 70.0, ["soil_temp", "soil_moisture", "soil_ph", "soil_ec"], 0.2),
]

# =============================================================================
# 五、可控设备
# =============================================================================

ACTUATORS = {
    "vent":        {"label": "卷膜通风", "unit": "%",   "range": (0, 100), "zone_scoped": True},
    "shade":       {"label": "外遮阳",   "unit": "%",   "range": (0, 100), "zone_scoped": True},
    "fan_pad":     {"label": "风机湿帘", "unit": "%",   "range": (0, 100), "zone_scoped": True},
    "grow_light":  {"label": "补光灯",   "unit": "%",   "range": (0, 100), "zone_scoped": True},
    "irrigation":  {"label": "滴灌",     "unit": "mm",  "range": (0, 20),  "zone_scoped": True},
    "heater":      {"label": "加温",     "unit": "%",   "range": (0, 100), "zone_scoped": True},
    "co2_valve":   {"label": "CO₂ 施肥", "unit": "ppm", "range": (0, 1200),"zone_scoped": True},
}
