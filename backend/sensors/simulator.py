# -*- coding: utf-8 -*-
"""
设施农业环境模拟器
==================

不是"随机数发生器"，而是一套**降阶物理模型**：

    室外气象  →  温室能量平衡 / 水汽平衡 / CO₂ 平衡 / 土壤水量平衡  →  传感器读数

这样做的三个好处：
  1. 曲线有真实的昼夜节律、滞后与耦合（升温 → 饱和水汽压上升 → VPD 变大 →
     蒸腾加快 → 湿度升高 → 结露），而不是各自漂移的伪随机数；
  2. 决策 Agent 下发的指令会**真实改变**环境，形成闭环，数字自己有因果；
  3. 接入真实传感器后，物理模型可原地退化为"软测量 / 数据补全"，接口不变。

模型清单
--------
  WeatherModel      室外气象：季节 + 日变化 + 天气过程（OU 过程云量、降雨状态机）
  GreenhouseModel   温室：一阶能量平衡、水汽平衡、CO₂ 质量平衡
  FieldModel        露地：直接跟随室外，仅保留土壤水量平衡
  SoilModel         土壤：双层水量平衡（0–20 / 20–40 cm），Hargreaves 蒸散驱动
  WaterBodyModel    琴湖水体：热惯性、溶解氧与 pH 的昼夜变化

安全联锁
--------
真实温室都带"超温强制开窗"的硬件联锁，任何上层智能策略都不能阻止。
本模拟器中由 ``ZoneState.safety_vent`` 实现，让 Agent 无法把温室"烧死"。
"""

from __future__ import annotations

import math
import random
import time
from datetime import datetime

from . import physics as P
from .base import NodeReadings
from .. import config as C


# =============================================================================
# 随机过程：Ornstein-Uhlenbeck（均值回复）
# =============================================================================

class OU:
    """
    均值回复随机过程，用来生成"有记忆"的自然扰动。
    tau 为相关时间（秒），sigma 为平稳标准差。

    相比 AR(1) 的好处：直接用物理时间参数化，仿真倍速改变时统计特性不变。
    """

    def __init__(self, tau: float, sigma: float, rng: random.Random):
        self.tau = tau
        self.sigma = sigma
        self.rng = rng
        self.x = 0.0

    def step(self, dt: float) -> float:
        if dt <= 0:
            return self.x
        rho = math.exp(-dt / self.tau)
        self.x = rho * self.x + math.sqrt(max(1e-12, 1 - rho * rho)) * self.rng.gauss(0, self.sigma)
        return self.x


# =============================================================================
# 室外气象
# =============================================================================

class WeatherModel:
    """室外气象模型，以徐州（北纬 34.26°，暖温带半湿润季风气候）为背景。"""

    def __init__(self, rng: random.Random, start_ts: float, scenario: str = "normal"):
        self.rng = rng
        self._now_ts = start_ts
        self.doy = datetime.fromtimestamp(start_ts).timetuple().tm_yday

        # --- 状态 ---
        self.base_cloud = 0.25
        self.rain = 0.0
        self.rain_state = "clear"
        self.rain_timer = 0.0
        self.synoptic_base = 0.0   # 场景给定的天气过程基准（℃）
        self.synoptic = 0.0        # 当前天气过程温度异常 (K)
        self.dewpoint = 9.0        # 露点 (℃)

        # --- 随机过程 ---
        self.ou_cloud = OU(4 * 3600, 0.20, rng)
        self.ou_wind = OU(1.2 * 3600, 0.75, rng)
        self.ou_synoptic = OU(36 * 3600, 1.6, rng)
        self.ou_dew = OU(10 * 3600, 0.85, rng)

        # --- 输出 ---
        self.cloud = 0.25
        self.t_out = 15.0
        self.rh_out = 65.0
        self.ah_out = P.absolute_humidity(15.0, 65.0)
        self.wind = 2.0
        self.ghi = 0.0
        self.par = 0.0
        self.lux = 0.0
        self.elev = 0.0
        self.azimuth = 0.0
        self.et0 = 3.0
        self.t_max_day = 20.0
        self.t_min_day = 6.0
        self.scenario = "normal"

        self.apply_scenario(scenario)
        self.update_sun()
        self.update_air()
        self.update_et0()

    # ------------------------------------------------------------------
    def apply_scenario(self, name: str):
        """演示场景预设。"""
        self.scenario = name
        presets = {
            "normal":   dict(cloud=0.30, dew=9.0,  wind=2.0, syn=0.0,  rain=0.0),
            "sunny":    dict(cloud=0.06, dew=7.0,  wind=1.6, syn=1.0,  rain=0.0),
            "cloudy":   dict(cloud=0.75, dew=11.0, wind=2.6, syn=-0.5, rain=0.0),
            "rainy":    dict(cloud=0.94, dew=15.5, wind=3.6, syn=-2.0, rain=5.0),
            "heatwave": dict(cloud=0.10, dew=17.0, wind=1.2, syn=7.0,  rain=0.0),
            "coldwave": dict(cloud=0.50, dew=-1.0, wind=4.5, syn=-9.0, rain=0.0),
        }
        c = presets.get(name, presets["normal"])
        self.base_cloud = c["cloud"]
        self.cloud = c["cloud"]
        self.dewpoint = c["dew"]
        self.wind = c["wind"]
        self.synoptic_base = c["syn"]
        self.synoptic = c["syn"]
        if c["rain"] > 0:
            self.rain = c["rain"]
            self.rain_state = "raining"
            self.rain_timer = 2.5
        else:
            self.rain = 0.0
            self.rain_state = "clear"
        self.update_sun()
        self.update_air()

    # ------------------------------------------------------------------
    def now(self) -> datetime:
        return datetime.fromtimestamp(self._now_ts)

    def seasonal_mean(self) -> float:
        """年周期平均气温：徐州 1 月约 2 ℃，7 月约 28 ℃。"""
        return 15.0 - 13.0 * math.cos(2 * math.pi * (self.doy - 15) / 365.0)

    # ------------------------------------------------------------------
    def step(self, dt: float):
        """推进天气状态机。dt 为仿真秒数。"""
        hours = dt / 3600.0
        # 云量 = 场景基准 + 慢变扰动
        self.cloud = P.clamp(self.base_cloud + self.ou_cloud.step(dt), 0.02, 0.99)
        # 天气过程温度异常同理：OU 过程本身即异常值，不可再与上一时刻累加，
        # 否则会退化为随机游走，几十小时后气温会漂移到物理上不可能的值。
        self.synoptic = P.clamp(self.synoptic_base + self.ou_synoptic.step(dt), -11.0, 11.0)

        base_dew = self.seasonal_mean() - 4.5
        self.dewpoint = P.clamp(base_dew + self.synoptic * 0.55 + self.ou_dew.step(dt),
                                -16.0, 27.0)

        self._step_rain(hours)
        if self.rain > 0.3:
            self.dewpoint = max(self.dewpoint, self.t_out - 1.0)
            self.cloud = max(self.cloud, 0.86)

        self.wind = P.clamp(1.0 + 1.6 * (1 - self.cloud) + self.rain * 0.22
                            + self.ou_wind.step(dt), 0.1, 18.0)

    def _step_rain(self, hours: float):
        if self.rain_state == "clear":
            if self.cloud > 0.80 and self.rng.random() < 0.005 * hours:
                self.rain_state = "building"
                self.rain_timer = self.rng.uniform(0.3, 1.2)
            self.rain = max(0.0, self.rain - 0.8 * hours)
        elif self.rain_state == "building":
            self.rain_timer -= hours
            self.rain += (self.rng.uniform(2.0, 8.0) - self.rain) * min(1.0, hours * 1.2)
            if self.rain_timer <= 0:
                self.rain_state = "raining"
                self.rain_timer = self.rng.uniform(0.5, 3.0)
        elif self.rain_state == "raining":
            self.rain_timer -= hours
            self.rain = P.clamp(self.rain + self.rng.gauss(0, 1.2) * math.sqrt(max(hours, 1e-4)) * 2.5,
                                0.4, 40.0)
            if self.rain_timer <= 0:
                self.rain_state = "clearing"
                self.rain_timer = self.rng.uniform(0.3, 1.0)
        else:
            self.rain_timer -= hours
            self.rain = max(0.0, self.rain - 6.0 * hours)
            if self.rain_timer <= 0:
                self.rain_state = "clear"
                self.rain = 0.0

    # ------------------------------------------------------------------
    def update_sun(self):
        now = self.now()
        hour = now.hour + now.minute / 60.0 + now.second / 3600.0
        self.elev = P.solar_elevation(C.SITE["latitude"], self.doy, hour)
        self.azimuth = P.solar_azimuth(C.SITE["latitude"], self.doy, hour)
        clear = P.clear_sky_ghi(self.elev)
        trans = 1.0 - 0.80 * (self.cloud ** 1.3)
        self.ghi = clear * trans * (1.0 - min(0.60, self.rain * 0.05))
        self.par = P.ghi_to_par(self.ghi)
        self.lux = P.ghi_to_lux(self.ghi)

    def update_air(self):
        now = self.now()
        hour = now.hour + now.minute / 60.0 + now.second / 3600.0
        base = self.seasonal_mean() + self.synoptic
        damp = (1.0 - 0.55 * self.cloud) * (1.0 - min(0.45, self.rain * 0.06))
        amp = 5.6 * damp
        self.t_out = base + amp * math.sin(2 * math.pi * (hour - 9.0) / 24.0)
        if self.rain > 0.5:
            self.t_out -= min(3.5, self.rain * 0.14)

        # 室外绝对湿度由露点决定（一天内近似守恒），相对湿度由此自然涌现
        self.ah_out = P.absolute_humidity(self.dewpoint, 100.0)
        if self.rain > 0.4:
            self.ah_out = max(self.ah_out, P.absolute_humidity(self.t_out - 0.6, 100.0))
        self.rh_out = P.clamp(P.rh_from_absolute(self.t_out, self.ah_out), 10.0, 100.0)

    def update_et0(self):
        base = self.seasonal_mean() + self.synoptic
        amp = 5.6 * (1 - 0.55 * self.cloud)
        self.t_max_day = base + amp
        self.t_min_day = base - amp
        self.et0 = P.reference_et0(base, self.t_max_day, self.t_min_day,
                                   C.SITE["latitude"], self.doy)


# =============================================================================
# 分区状态
# =============================================================================

class ZoneState:
    """一座温室（或一块露地）的全部状态与物理参数。"""

    def __init__(self, zone_id: str, crop_key: str, kind: str, floor_area: float,
                 transmittance: float = 0.85, volume_height: float = 3.6,
                 u_value: float = 4.5, ach_base: float = 3.0, ach_max: float = 62.0,
                 heater_cap: float = 180.0, light_ppfd: float = 160.0):
        self.id = zone_id
        self.crop_key = crop_key
        self.crop = C.CROPS.get(crop_key)
        self.kind = kind                      # greenhouse / field
        self.floor_area = floor_area
        self.tau = transmittance
        self.h = volume_height
        self.u = u_value
        self.ach_base = ach_base
        self.ach_max = ach_max
        self.heater_cap = heater_cap
        self.light_ppfd = light_ppfd

        # --- 环境状态 ---
        fc = self.crop["vwc"]["field_capacity"] if self.crop else 32.0
        lo = self.crop["vwc"]["lower"] if self.crop else 26.0
        self.t_in = 16.0
        self.ah_in = P.absolute_humidity(16.0, 70.0)
        self.co2 = 430.0
        self.soil_t = 16.0
        # 墒情初值略高于灌溉触发线，使演示开场数小时内即可看到一次完整的
        # "亏缺 → 决策 → 滴灌 → 回升"闭环
        self.vwc1 = min(fc * 0.95, lo + 1.6)
        self.vwc2 = fc * 0.90
        self.soil_ph = 6.6
        self.soil_ec = 2.0

        # --- 累积 ---
        self.energy_kwh = 0.0
        self.water_l = 0.0
        self.dli_today = 0.0
        self._dli_day = -1

        # --- 设备 ---
        self.act = {k: 0.0 for k in C.ACTUATORS}
        self._irrigation_pending = 0.0
        self._irrigation_rate = 5.0        # 滴灌强度 mm/h
        self.safety_vent = 0.0             # 超温联锁强制通风量
        self.last_irrigation_ts = 0.0

        # --- 派生 ---
        self.rh_in = 70.0
        self.vpd_in = 0.6
        self.par_in = 0.0

    # ------------------------------------------------------------------
    def vent_effective(self) -> float:
        """实际通风量 = 策略设定与安全联锁取大。"""
        return max(self.act["vent"], self.safety_vent)

    def set_actuator(self, key: str, value: float):
        if key not in C.ACTUATORS:
            return
        lo, hi = C.ACTUATORS[key]["range"]
        v = P.clamp(float(value), lo, hi)
        if key == "irrigation":
            if v > 0:
                self._irrigation_pending += v
            return
        self.act[key] = v

    def snapshot(self, now_ts: float = 0.0) -> dict:
        return {
            "id": self.id,
            "name": C.ZONES[self.id]["name"] if self.id in C.ZONES else self.id,
            "crop": self.crop_key,
            "crop_name": self.crop["name"] if self.crop else "—",
            "air_temp": round(self.t_in, 1),
            "air_humidity": round(self.rh_in, 1),
            "vpd": round(self.vpd_in, 2),
            "co2": round(self.co2, 0),
            "par": round(self.par_in, 0),
            "soil_temp": round(self.soil_t, 1),
            "soil_moisture": round(self.vwc1, 1),
            "soil_ph": round(self.soil_ph, 2),
            "soil_ec": round(self.soil_ec, 2),
            "dli": round(self.dli_today, 1),
            "vent_effective": round(self.vent_effective(), 1),
            "safety_vent": round(self.safety_vent, 1),
            "actuators": {k: round(v, 1) for k, v in self.act.items()},
            "irrigation_pending": round(self._irrigation_pending, 2),
            "irrigating": self._irrigation_pending > 0.01,
            "energy_kwh": round(self.energy_kwh, 3),
            "water_l": round(self.water_l, 1),
        }


# =============================================================================
# 温室物理
# =============================================================================

class GreenhouseModel:
    """温室一阶能量平衡 + 水汽平衡 + CO₂ 平衡。"""

    def __init__(self, zone: ZoneState, rng: random.Random):
        self.z = zone
        self.rng = rng

    def step(self, dt: float, w: WeatherModel, hour_of_day: float):
        z = self.z

        # ---- 1. 室内光照 ----
        shade_eff = z.act["shade"] / 100.0 * 0.72
        light_extra = (z.act["grow_light"] / 100.0) * z.light_ppfd
        z.par_in = w.par * z.tau * (1 - shade_eff) + light_extra
        ghi_in = w.ghi * z.tau * (1 - shade_eff)

        # ---- 2. 蒸腾（潜热汇）----
        kn = z.crop["kc"] if z.crop else 1.0
        vpd_factor = P.clamp(z.vpd_in / 1.0, 0.20, 1.7)
        et_mm_h = kn * 0.408 * 0.62 * ghi_in * 0.0036 / P.LATENT_HEAT * vpd_factor
        et_mm_h = P.clamp(et_mm_h, 0.0, 1.5)
        # 夜间少量吐水/蒸发
        et_mm_h += 0.010 * vpd_factor
        q_latent = et_mm_h * 681.0

        # ---- 3. 换气次数 ----
        vent = z.vent_effective() / 100.0
        wind_gain = 0.65 + 0.35 * min(1.7, w.wind / 2.5)
        ach = z.ach_base + (z.ach_max - z.ach_base) * (vent ** 1.15) * wind_gain
        fan = z.act["fan_pad"] / 100.0
        ach += fan * 26.0

        # ---- 4. 能量平衡 ----
        q_light = (z.act["grow_light"] / 100.0) * z.light_ppfd * 4.57 * 0.10
        q_solar = ghi_in * 0.92
        q_trans = z.u * 1.5 * (z.t_in - w.t_out)
        q_vent = P.RHO_AIR * P.CP_AIR * (ach / 3600.0) * z.h * (z.t_in - w.t_out)
        q_heat = (z.act["heater"] / 100.0) * z.heater_cap
        q_soil = 2.2 * (z.soil_t - z.t_in)

        q_fan = 0.0
        if fan > 0.01:
            twb = P.wet_bulb(w.t_out, w.rh_out)
            q_fan = -fan * 46.0 * max(0.0, z.t_in - twb)

        c_eff = 26000.0 + 9000.0 * (1 - vent)
        net = q_solar + q_light + q_heat - q_trans - q_vent - q_latent + q_soil + q_fan
        z.t_in += net / c_eff * dt
        z.t_in = P.clamp(z.t_in, w.t_out - 7.0, w.t_out + 36.0)

        # ---- 5. 水汽平衡 ----
        e_g = et_mm_h / 3600.0 * 1000.0
        d_trans = e_g / z.h
        d_vent = (ach / 3600.0) * (z.ah_in - w.ah_out)
        d_fan = 0.0
        if fan > 0.01:
            ah_wb = P.absolute_humidity(P.wet_bulb(w.t_out, w.rh_out), 100.0)
            d_fan = fan * 0.5 * (ah_wb - z.ah_in) / 45.0

        z.ah_in += (d_trans - d_vent + d_fan) * dt
        rh = P.rh_from_absolute(z.t_in, z.ah_in)
        if rh > 97.0:                     # 覆盖层结露
            z.ah_in = P.absolute_humidity(z.t_in, 97.0)
            rh = 97.0
        z.rh_in = P.clamp(rh, 15.0, 100.0)
        z.ah_in = P.absolute_humidity(z.t_in, z.rh_in)
        z.vpd_in = P.vpd(z.t_in, z.rh_in)

        # ---- 6. CO₂ ----
        light_lim = z.par_in / (z.par_in + 420.0)
        co2_lim = 1.0 - math.exp(-max(0.0, z.co2) / 520.0)
        t_opt = (z.crop["temp"]["opt_min"] + z.crop["temp"]["opt_max"]) / 2 if z.crop else 24.0
        temp_lim = math.exp(-0.5 * ((z.t_in - t_opt) / 8.0) ** 2)
        # 夜间呼吸作用释放 CO₂
        night_resp = 0.006 if z.par_in < 20 else 0.0
        uptake = 0.140 * light_lim * co2_lim * temp_lim - night_resp
        vent_ex = (ach / 3600.0) * (z.co2 - 428.0)
        inject = (z.act["co2_valve"] / 100.0) * 0.32
        z.co2 = P.clamp(z.co2 + (inject - uptake - vent_ex) * dt, 240.0, 1600.0)

        # ---- 7. 土壤 ----
        SoilModel(z, w, self.rng).step(dt, et_mm_h)

        # ---- 8. 光积分与能耗 ----
        doy = w.now().timetuple().tm_yday
        if doy != z._dli_day:
            z._dli_day = doy
            z.dli_today = 0.0
        z.dli_today += z.par_in * dt / 1e6

        # 功率密度 (W/m²) × 建筑面积 (m²) × 时长 (s) → kWh
        power_density = ((z.act["heater"] / 100.0) * z.heater_cap
                         + (z.act["grow_light"] / 100.0) * 55.0
                         + (z.act["fan_pad"] / 100.0) * 22.0
                         + (z.act["vent"] / 100.0) * 2.0
                         + (z.act["shade"] / 100.0) * 1.5)
        z.energy_kwh += power_density * z.floor_area * dt / 3.6e6

        z.t_in += self.rng.gauss(0, 0.010)


class FieldModel:
    """露地：无围护结构，环境直接跟随室外，只有土壤水量平衡需要单独算。"""

    def __init__(self, zone: ZoneState, rng: random.Random):
        self.z = zone
        self.rng = rng

    def step(self, dt: float, w: WeatherModel, hour_of_day: float):
        z = self.z
        # 环境跟随室外（加大时间常数避免抖动）
        k = min(1.0, dt / 240.0)
        z.t_in += (w.t_out - z.t_in) * k
        z.rh_in += (w.rh_out - z.rh_in) * k
        z.vpd_in = P.vpd(z.t_in, z.rh_in)
        z.par_in = w.par + (z.act["grow_light"] / 100.0) * z.light_ppfd
        z.co2 = 428.0

        kn = z.crop["kc"] if z.crop else 1.0
        et_mm_h = kn * 0.408 * 0.68 * w.ghi * 0.0036 / P.LATENT_HEAT * \
            P.clamp(z.vpd_in / 1.0, 0.2, 1.7)
        et_mm_h = P.clamp(et_mm_h, 0.0, 1.8)

        SoilModel(z, w, self.rng).step(dt, et_mm_h)

        z.dli_today += z.par_in * dt / 1e6
        doy = w.now().timetuple().tm_yday
        if doy != z._dli_day:
            z._dli_day = doy
            z.dli_today = 0.0


class SoilModel:
    """双层土壤水量平衡 + 土壤温度一阶响应。"""

    def __init__(self, z: ZoneState, w: WeatherModel, rng: random.Random):
        self.z, self.w, self.rng = z, w, rng

    def step(self, dt: float, et_mm_h: float):
        z, w = self.z, self.w
        hours = dt / 3600.0

        # 灌溉
        irr_mm_h = 0.0
        if z._irrigation_pending > 0:
            irr_mm_h = min(z._irrigation_rate, z._irrigation_pending / max(hours, 1e-6))
            applied = irr_mm_h * hours
            z._irrigation_pending = max(0.0, z._irrigation_pending - applied)
            z.water_l += applied * z.floor_area

        rain_mm_h = w.rain * 0.85 if z.kind == "field" else 0.0

        crop = z.crop or C.CROPS["leafy"]
        vwc = crop["vwc"]
        d1 = d2 = 200.0
        fc1 = vwc["field_capacity"]
        fc2 = fc1 * 0.95
        wp = vwc["wilting"]

        et1, et2 = et_mm_h * 0.65, et_mm_h * 0.35
        inflow = irr_mm_h + rain_mm_h

        z.vwc1 += (inflow - et1) / d1 * 100.0 * hours
        perc = 0.0
        if z.vwc1 > fc1:
            perc = min(z.vwc1 - fc1, 5.0) * hours * d1 / 100.0
            z.vwc1 -= perc / d1 * 100.0
        z.vwc2 += (perc - et2) / d2 * 100.0 * hours
        if z.vwc2 > fc2:
            z.vwc2 -= min(z.vwc2 - fc2, 2.0) * hours

        z.vwc1 = P.clamp(z.vwc1, wp * 0.55, fc1 * 1.10)
        z.vwc2 = P.clamp(z.vwc2, wp * 0.60, fc2 * 1.08)

        # 土壤温度：外界驱动的低通
        t_drive = 0.55 * w.t_out + 0.45 * z.t_in + 1.4 * min(1.0, w.ghi / 420.0)
        z.soil_t += (t_drive - z.soil_t) * min(1.0, dt / (5.5 * 3600.0))

        # pH / EC 缓变
        if irr_mm_h > 0:
            z.soil_ec = max(0.6, z.soil_ec - 0.004 * hours)
        else:
            z.soil_ec = min(3.6, z.soil_ec + 0.0025 * hours)
        ph_mid = (crop["ph"]["min"] + crop["ph"]["max"]) / 2
        z.soil_ph += (ph_mid - z.soil_ph) * min(1.0, dt / (48 * 3600.0))
        z.soil_ph = P.clamp(z.soil_ph + self.rng.gauss(0, 0.0015), 4.8, 8.6)
        z.soil_ec = P.clamp(z.soil_ec, 0.3, 4.2)
        z.vwc1 += self.rng.gauss(0, 0.006)
        z.soil_t += self.rng.gauss(0, 0.004)


# =============================================================================
# 琴湖水体
# =============================================================================

class WaterBodyModel:
    """景观水体：热惯性、溶解氧、pH 昼夜变化。"""

    def __init__(self, rng: random.Random):
        self.rng = rng
        self.temp = 16.0
        self.do = 7.4
        self.ph = 7.9

    def step(self, dt: float, w: WeatherModel):
        self.temp += (w.t_out - self.temp) * min(1.0, dt / (26 * 3600.0))
        sat = 14.6 - 0.41 * self.temp + 0.008 * self.temp ** 2
        photo = min(2.4, w.ghi / 500.0 * 1.9)
        self.do += (sat * 0.70 + photo - self.do) * min(1.0, dt / (2.2 * 3600.0))
        ph_t = 7.72 + min(0.72, w.ghi / 700.0 * 0.55)
        self.ph += (ph_t - self.ph) * min(1.0, dt / (3.0 * 3600.0))
        self.do = P.clamp(self.do, 2.0, 12.0)
        self.ph = P.clamp(self.ph, 6.6, 9.2)


# =============================================================================
# 总控
# =============================================================================

class Simulator:
    """
    基地数字孪生的仿真内核。

    对外只暴露四个动作：
        step(dt_real, speed)   推进仿真
        readings()             取全部节点传感器读数
        set_actuator(...)      设备控制
        get_states()           分区环境状态
    """

    def __init__(self, start_ts: float | None = None, seed: int = 20260825,
                 scenario: str = "normal", warmup_hours: float = 8.0):
        self.rng = random.Random(seed)
        self.ts = float(start_ts if start_ts is not None else time.time())
        self.speed = 1.0
        self.warmup_hours = warmup_hours

        self.weather = WeatherModel(self.rng, self.ts, scenario)
        self.water = WaterBodyModel(self.rng)

        self.zones: dict[str, ZoneState] = {
            "Z2": ZoneState("Z2", "tomato", "greenhouse", 33 * 58,
                            transmittance=0.84, volume_height=3.8,
                            u_value=4.6, ach_base=3.0, ach_max=66.0,
                            heater_cap=160.0, light_ppfd=170.0),
            "Z3": ZoneState("Z3", "peony", "greenhouse", 52 * 24,
                            transmittance=0.82, volume_height=2.9,
                            u_value=5.2, ach_base=4.0, ach_max=58.0,
                            heater_cap=120.0, light_ppfd=140.0),
            "Z4": ZoneState("Z4", "strawberry", "greenhouse", 16 * 58,
                            transmittance=0.78, volume_height=3.4,
                            u_value=3.4, ach_base=2.5, ach_max=48.0,
                            heater_cap=150.0, light_ppfd=190.0),
            "Z5": ZoneState("Z5", "leafy", "field", 60 * 24,
                            transmittance=1.0, volume_height=2.0,
                            u_value=0.0, ach_base=45.0, ach_max=45.0,
                            heater_cap=0.0, light_ppfd=0.0),
        }
        self.models: dict[str, object] = {}
        for zid, z in self.zones.items():
            cls = GreenhouseModel if z.kind == "greenhouse" else FieldModel
            self.models[zid] = cls(z, self.rng)

        # 预热：从 start_ts 往前推 warmup_hours，结束时正好落在 start_ts
        self._warmup()

    # ------------------------------------------------------------------
    def now(self) -> datetime:
        return datetime.fromtimestamp(self.ts)

    def _warmup(self):
        """回放前 warmup_hours 小时，让状态收敛到与初春/当前时刻一致的物理量。"""
        target = self.ts
        self.ts = target - self.warmup_hours * 3600.0
        self.weather._now_ts = self.ts
        n = int(self.warmup_hours * 3600 / 30)
        for _ in range(n):
            self._step_raw(30.0)
        # 落回起点（预热过程中时钟已推进 warmup_hours）
        self.ts = target
        self.weather._now_ts = self.ts
        self.weather.update_air()
        self.weather.update_sun()
        self.weather.update_et0()

    # ------------------------------------------------------------------
    def _safety_interlock(self):
        """超温强制开窗联锁：环境温度超过 30 ℃ 时不容许通风量为 0。"""
        for z in self.zones.values():
            if z.kind != "greenhouse":
                z.safety_vent = 0.0
                continue
            over = z.t_in - 30.0
            z.safety_vent = P.clamp(over / 6.0 * 100.0, 0.0, 100.0)

    def step(self, dt_real: float, speed: float | None = None) -> None:
        if speed is not None:
            self.speed = max(0.0, float(speed))
        self._step_raw(dt_real * self.speed)

    def _step_raw(self, dt_sim: float):
        if dt_sim <= 0:
            return
        while dt_sim > 0:
            h = min(20.0, dt_sim)
            dt_sim -= h
            self.ts += h
            self.weather._now_ts = self.ts
            now = self.weather.now()
            hour = now.hour + now.minute / 60.0 + now.second / 3600.0

            self.weather.update_air()
            self.weather.step(h)
            self.weather.update_sun()
            self.weather.update_et0()

            self._safety_interlock()
            for zid, model in self.models.items():
                model.step(h, self.weather, hour)

            self.water.step(h, self.weather)

    # ------------------------------------------------------------------
    def set_actuator(self, zone_id: str, key: str, value: float) -> dict:
        z = self.zones.get(zone_id)
        if not z:
            return {"ok": False, "error": f"未知分区 {zone_id}"}
        z.set_actuator(key, value)
        if key == "irrigation" and value > 0:
            z.last_irrigation_ts = self.ts
        return {"ok": True, "zone": zone_id, "actuator": key,
                "value": z.act.get(key, z._irrigation_pending)}

    def get_states(self) -> dict:
        return {zid: z.snapshot(self.ts) for zid, z in self.zones.items()}

    # ------------------------------------------------------------------
    def readings(self) -> dict[str, NodeReadings]:
        """按 config.SENSOR_NODES 生成全部节点读数（叠加测量噪声）。"""
        out: dict[str, NodeReadings] = {}
        w = self.weather
        for node in C.SENSOR_NODES:
            nid, zone_id, kind = node["id"], node["zone"], node["kind"]
            z = self.zones.get(zone_id)
            vals: dict[str, float] = {}

            if kind == "weather":
                vals = {"air_temp": w.t_out, "air_humidity": w.rh_out, "par": w.par,
                        "wind_speed": w.wind, "rainfall": w.rain,
                        "soil_temp": (z.soil_t if z else w.t_out - 2.0)}
            elif kind == "water":
                vals = {"water_temp": self.water.temp, "water_do": self.water.do,
                        "water_ph": self.water.ph}
            elif z is not None:
                vals = {"air_temp": z.t_in, "air_humidity": z.rh_in,
                        "soil_temp": z.soil_t, "soil_moisture": z.vwc1,
                        "soil_ph": z.soil_ph, "soil_ec": z.soil_ec,
                        "par": z.par_in, "co2": z.co2}

            noisy = {}
            for k, v in vals.items():
                rng_span = abs(C.METRICS.get(k, {}).get("range", (0, 1))[1]
                               - C.METRICS.get(k, {}).get("range", (0, 1))[0])
                noisy[k] = v + self.rng.gauss(0, rng_span * 0.0012)

            out[nid] = NodeReadings(
                node_id=nid, zone=zone_id, kind=kind, ts=self.ts,
                values={k: noisy[k] for k in node["metrics"] if k in noisy},
                quality="good", online=True, source="simulator")
        return out

    # ------------------------------------------------------------------
    def environment(self) -> dict:
        w = self.weather
        now = self.now()
        return {
            "ts": self.ts,
            "speed": self.speed,
            "time_str": now.strftime("%Y-%m-%d %H:%M:%S"),
            "hour": now.hour + now.minute / 60.0,
            "solar_elevation": round(w.elev, 2),
            "solar_azimuth": round(w.azimuth, 2),
            "ghi": round(w.ghi, 1),
            "par": round(w.par, 0),
            "lux": round(w.lux, 0),
            "cloud": round(w.cloud, 2),
            "rain": round(w.rain, 1),
            "wind": round(w.wind, 1),
            "outdoor_temp": round(w.t_out, 1),
            "outdoor_humidity": round(w.rh_out, 1),
            "et0": round(w.et0, 2),
            "scenario": w.scenario,
            "is_day": w.elev > 0,
        }
