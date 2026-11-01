# -*- coding: utf-8 -*-
"""
植物环境物理计算基础函数
========================

这里只放"公式"，不放状态。所有函数均为纯函数，便于单独验证。

参考来源：
  · 太阳几何与天文辐射 —— FAO-56 第 3 章
  · 晴天太阳辐射 —— Haurwitz 晴空模型
  · 饱和水汽压、VPD、露点 —— FAO-56 第 3 章
  · 湿球温度 —— Stull (2011) 经验式
  · 参考蒸散量 ET0 —— Hargreaves-Samani (1985) 温度+辐射法
"""

from __future__ import annotations

import math

# 太阳常数 (MJ / m² / min)
SOLAR_CONSTANT = 0.0820
# 汽化潜热 (MJ / kg)
LATENT_HEAT = 2.45
# 干空气定压比热 (J / kg·K)
CP_AIR = 1005.0
# 空气密度 (kg / m³)
RHO_AIR = 1.2


# ---------------------------------------------------------------------------
# 太阳几何
# ---------------------------------------------------------------------------

def solar_declination(doy: int) -> float:
    """太阳赤纬角（弧度）。"""
    return math.radians(23.45) * math.sin(2 * math.pi * (284 + doy) / 365.0)


def sunset_hour_angle(lat_deg: float, doy: int) -> float:
    """日落时角（弧度）。"""
    phi = math.radians(lat_deg)
    delta = solar_declination(doy)
    x = -math.tan(phi) * math.tan(delta)
    x = max(-1.0, min(1.0, x))
    return math.acos(x)


def solar_elevation(lat_deg: float, doy: int, solar_hour: float) -> float:
    """
    太阳高度角（度）。solar_hour 为真太阳时（0~24）。
    负值表示太阳在地平线以下。
    """
    phi = math.radians(lat_deg)
    delta = solar_declination(doy)
    omega = math.radians(15.0 * (solar_hour - 12.0))
    sin_h = math.sin(phi) * math.sin(delta) + math.cos(phi) * math.cos(delta) * math.cos(omega)
    sin_h = max(-1.0, min(1.0, sin_h))
    return math.degrees(math.asin(sin_h))


def solar_azimuth(lat_deg: float, doy: int, solar_hour: float) -> float:
    """
    太阳方位角（度，正北为 0，顺时针）。
    用于决定三维场景中阴影方向。
    """
    phi = math.radians(lat_deg)
    delta = solar_declination(doy)
    omega = math.radians(15.0 * (solar_hour - 12.0))
    h = math.radians(solar_elevation(lat_deg, doy, solar_hour))
    cos_az = (math.sin(delta) - math.sin(h) * math.sin(phi)) / (
        math.cos(h) * math.cos(phi) + 1e-9)
    cos_az = max(-1.0, min(1.0, cos_az))
    az = math.degrees(math.acos(cos_az))
    return az if omega <= 0 else 360.0 - az


def extraterrestrial_radiation(lat_deg: float, doy: int) -> float:
    """大气顶层太阳辐射 Ra (MJ / m² / d)。"""
    phi = math.radians(lat_deg)
    delta = solar_declination(doy)
    ws = sunset_hour_angle(lat_deg, doy)
    dr = 1 + 0.033 * math.cos(2 * math.pi * doy / 365.0)
    ra = (24 * 60 / math.pi) * SOLAR_CONSTANT * dr * (
        ws * math.sin(phi) * math.sin(delta) +
        math.cos(phi) * math.cos(delta) * math.sin(ws))
    return max(0.0, ra)


def clear_sky_ghi(elev_deg: float) -> float:
    """
    Haurwitz 晴空水平面总辐射 (W / m²)。
    elev_deg 为太阳高度角（度）。
    """
    if elev_deg <= 0.5:
        return 0.0
    cos_z = math.sin(math.radians(elev_deg))
    cos_z = max(0.01, cos_z)
    return 1098.0 * cos_z * math.exp(-0.057 / cos_z)


def ghi_to_par(ghi: float) -> float:
    """水平面总辐射 → 光合有效辐射 PPFD (μmol / m² / s)。"""
    return max(0.0, ghi * 0.45 * 4.57)


def ghi_to_lux(ghi: float) -> float:
    """水平面总辐射 → 照度 (lux)，日光光视效能约 120 lm/W。"""
    return max(0.0, ghi * 120.0)


# ---------------------------------------------------------------------------
# 湿度与热力学
# ---------------------------------------------------------------------------

def sat_vapor_pressure(t_c: float) -> float:
    """饱和水汽压 es (kPa)。Tetens 公式。"""
    return 0.6108 * math.exp(17.27 * t_c / (t_c + 237.3))


def vpd(t_c: float, rh: float) -> float:
    """饱和水汽压差 (kPa)。"""
    return max(0.0, sat_vapor_pressure(t_c) * (1.0 - rh / 100.0))


def absolute_humidity(t_c: float, rh: float) -> float:
    """绝对湿度 (g / m³)，作为室内水汽收支的状态量。"""
    es_hpa = sat_vapor_pressure(t_c) * 10.0
    return 216.7 * (rh / 100.0) * es_hpa / (t_c + 273.15)


def rh_from_absolute(t_c: float, ah: float) -> float:
    """由绝对湿度反算相对湿度 (%)。"""
    es_hpa = sat_vapor_pressure(t_c) * 10.0
    denom = 216.7 * es_hpa
    if denom <= 0:
        return 0.0
    return max(0.0, min(100.0, ah * (t_c + 273.15) / denom * 100.0))


def dew_point(t_c: float, rh: float) -> float:
    """露点温度 (°C)，Magnus 反式。"""
    rh = max(1.0, min(100.0, rh))
    a, b = 17.27, 237.3
    gamma = math.log(rh / 100.0) + a * t_c / (b + t_c)
    return b * gamma / (a - gamma)


def wet_bulb(t_c: float, rh: float) -> float:
    """
    湿球温度 (°C)。Stull (2011) 经验式，适用于标准大气压。
    风机湿帘的降温极限就是逼近湿球温度。
    """
    rh = max(1.0, min(100.0, rh))
    tw = (t_c * math.atan(0.151977 * math.sqrt(rh + 8.313659))
          + math.atan(t_c + rh)
          - math.atan(rh - 1.676331)
          + 0.00391838 * (rh ** 1.5) * math.atan(0.023101 * rh)
          - 4.686035)
    return min(tw, t_c)


# ---------------------------------------------------------------------------
# 蒸散
# ---------------------------------------------------------------------------

def reference_et0(t_mean: float, t_max: float, t_min: float,
                  lat_deg: float, doy: int) -> float:
    """
    参考作物蒸散量 ET0 (mm / d)。Hargreaves-Samani 法。
    仅用温度与天文辐射，无需风速与湿度数据，适合作为基地级估算。
    """
    ra_mm = extraterrestrial_radiation(lat_deg, doy) * 0.408
    dtr = max(1.0, t_max - t_min)
    et0 = 0.0023 * (t_mean + 17.8) * math.sqrt(dtr) * ra_mm
    return max(0.0, et0)


def clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else (hi if v > hi else v)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * clamp(t, 0.0, 1.0)


def smoothstep(edge0: float, edge1: float, x: float) -> float:
    if edge1 == edge0:
        return 0.0
    t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3 - 2 * t)
