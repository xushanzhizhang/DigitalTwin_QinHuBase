# -*- coding: utf-8 -*-
"""
农艺知识库与决策规则
====================

决策 Agent 的"专业知识"集中在这里，与调度逻辑（engine.py）分离。
这样做的原因很实际：以后要请农艺老师傅校准阈值，只需要改这一个文件。

设计约定（很重要）
------------------
每条规则**始终**返回一个目标状态，包括目标为 0 的情况。
早期版本用"条件不满足就 return"的写法，结果是遮阳网白天展开后夜里永远收不回去
—— 控制器必须能表达"关闭"这个意图，否则设备就卡在上一个状态了。

规则编号与依据
--------------
  R1  通风降温/除湿     —— 设施蔬菜生产技术规程（温度、湿度双目标）
  R2  外遮阳           —— 强辐射 + 高温耦合时的削峰手段
  R3  风机湿帘         —— 仅在外界湿球温度足够低时启用，否则越降越闷
  R4  补光             —— 依据 DLI 缺口（每日光积分）而非瞬时照度
  R5  滴灌             —— 依据根区水分亏缺（MAD 原则），而非固定时间表
  R6  加温             —— 防止亚低温冷害，优先于一切降温措施
  R7  CO₂ 施肥         —— 仅在通风关闭、光合活跃时进行，避免浪费
  R8  卷膜闭合（防雨/防风）—— 暴雨、大风时的保护性动作
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .. import config as C
from ..sensors import physics as P


# =============================================================================
# 物候期：让决策"看季节"，而不是一年到头顶着同一阈值空转
# =============================================================================

STAGES = {
    "peony": [
        ((1, 2), "休眠期", "低温春化中，控水控肥，保持根区偏干"),
        ((3, 3), "萌芽期", "芽体萌动，需水量上升，注意夜温防霜"),
        ((4, 5), "花期", "现蕾开花，水肥需求高峰，忌大水漫灌"),
        ((6, 9), "生长期", "营养生长与花芽分化，适度控水促根"),
        ((10, 10), "养分回流期", "地上部枯萎，减少灌溉，促进养分回根"),
        ((11, 12), "休眠期", "越冬休眠，保持土壤偏干，防积水烂根"),
    ],
    "tomato": [
        ((1, 2), "采收期", "越冬茬采收，重点保温与补光"),
        ((3, 5), "拉秧期", "生育后期，逐步控水提升品质"),
        ((6, 7), "休闲期", "高温闷棚消毒"),
        ((8, 9), "育苗期", "幼苗期，控温控湿防徒长"),
        ((10, 12), "开花坐果期", "水肥临界期，稳温稳墒防落花"),
    ],
    "strawberry": [
        ((1, 3), "采收盛期", "连续采收，水肥少量多次"),
        ((4, 5), "采收末期", "产量下降，准备育苗"),
        ((6, 8), "育苗期", "匍匐茎繁殖，需水量大"),
        ((9, 10), "定植缓苗期", "促根成活，小水勤浇"),
        ((11, 12), "花芽分化期", "短日照促花，控氮控水"),
    ],
    "leafy": [
        ((1, 12), "生长期", "水培/速生叶菜，稳定供应营养液"),
    ],
}


def growth_stage(crop_key: str, month: int) -> tuple[str, str]:
    """返回 (物候期名称, 管理要点)。"""
    for months, name, note in STAGES.get(crop_key, []):
        if months[0] <= month <= months[1]:
            return name, note
    return "生长期", "常规管理"


def temp_band(crop: dict, is_night: bool) -> tuple[float, float]:
    """
    返回当前时刻的温度调控区间。

    设施栽培里"适温"是白天目标；夜间作物以呼吸消耗为主，可低 5~8℃ 而不影响生长，
    死守白天温度会造成大量无谓加温 —— 这是很多"智能温室"能耗居高不下的根源。
    """
    t = crop["temp"]
    if is_night:
        return t.get("night_min", t["opt_min"] - 6), t.get("night_max", t["opt_max"] - 6)
    return t["opt_min"], t["opt_max"]


# =============================================================================
# 建议对象
# =============================================================================

@dataclass
class Proposal:
    """一条待裁决的设备指令建议。"""
    zone: str
    actuator: str
    value: float
    priority: int                 # 1 最高（安全）→ 4 最低（优化）
    confidence: float             # 0~1
    headline: str
    reasons: list[str] = field(default_factory=list)
    basis: str = ""
    expected: str = ""
    rule: str = ""

    def to_dict(self) -> dict:
        return {
            "zone": self.zone,
            "actuator": self.actuator,
            "value": round(self.value, 1),
            "priority": self.priority,
            "confidence": round(self.confidence, 2),
            "headline": self.headline,
            "reasons": self.reasons,
            "basis": self.basis,
            "expected": self.expected,
            "rule": self.rule,
        }


ACT_LABEL = {k: v["label"] for k, v in C.ACTUATORS.items()}


def _f(v: float, nd: int = 1) -> str:
    return f"{v:.{nd}f}"


# =============================================================================
# 规则实现
# =============================================================================

def rule_vent(z, crop, out: dict, prop: list[Proposal]):
    """
    R1 通风：温度优先，其次除湿；夜间以保温为先。

    这里的迟滞带是必须的。只用单一阈值时，"开窗→湿度下降→关窗→湿度回升→再开窗"
    会形成一个自激振荡，卷膜机一小时内能动作十几次。所以开启阈值与关闭阈值分开取。
    """
    t, rh = z.t_in, z.rh_in
    tmin, tmax = temp_band(crop, out["is_night"])
    already_open = z.vent_effective() > 5

    target = 0.0
    reasons: list[str] = []
    prio, conf = 2, 0.80
    expected = "关闭通风口以减少热量散失，维持夜间温度"

    # ---- 温度回路 ----
    # 已开窗：温度回落到上限以下 3℃ 才关；未开窗：超过上限才开
    t_threshold = (tmax - 3.0) if already_open else tmax
    if t > t_threshold:
        # 增益 9 %/℃ 是实测调出来的：增益提到 15 时，执行机构 15 min 的滞后
        # 与比例带宽度处在同一量级，回路会等幅振荡（开→过冷→关→过热→开）。
        target = P.clamp(15 + (t - t_threshold) * 9.0, 15, 100)
        reasons.append(f"棚内气温 {_f(t)}℃，超出当前时段"
                       f"{'夜间' if out['is_night'] else '白天'}适温上限 {_f(tmax)}℃")
        expected = f"预计 10~20 min 内棚温回落 {min(4.0, max(0.6, (t - tmax) * 0.6)):.1f}℃"
        conf = 0.90
        if t > tmax + 2.5:
            prio = 2          # 明显超温才升级为"重要"，否则只算常规调节

    # ---- 湿度回路（独立迟滞：88% 开启，80% 关闭）----
    rh_threshold = 80.0 if already_open else 88.0
    if rh > rh_threshold and target < 100:
        rh_target = P.clamp((rh - rh_threshold) * 6.0 + 15.0, 15, 70)
        if rh_target > target:
            target = rh_target
            reasons.append(f"棚内相对湿度 {_f(rh, 0)}%，"
                           f"露点 {_f(P.dew_point(t, rh))}℃ 逼近叶温，需通风除湿抑制灰霉病")
            expected = "降低棚内水汽含量，缩短叶面结露时间"

    # ---- 夜间保温限幅 ----
    if out["is_night"] and out["t_out"] < t - 3 and t > tmin and target > 12:
        reasons.append(f"夜间室外仅 {_f(out['t_out'])}℃，明显低于棚内，"
                       f"通风量限幅至 12% 以兼顾除湿与保温")
        target = 12.0

    prop.append(Proposal(
        zone=z.id, actuator="vent", value=target, priority=prio, confidence=conf,
        headline=("开启通风 " if target > 0 else "关闭通风 ") + f"{target:.0f}%",
        reasons=reasons,
        basis="R1 温度—湿度双目标通风：先满足适温区，再控制相对湿度低于 85%。"
              "高湿环境下即便温度合适，病害风险也会迅速上升。",
        expected=expected, rule="R1",
    ))


def rule_shade(z, crop, out: dict, prop: list[Proposal]):
    """R2 外遮阳：只有"光已过剩 + 温度也上来了"才值得遮。"""
    par, t = z.par_in, z.t_in
    _, tmax = temp_band(crop, out["is_night"])
    par_sat = crop["par_saturation"]

    target = 0.0
    reasons: list[str] = []
    expected = "收起遮阳网，恢复自然透光"

    if par > par_sat * 1.15 and t > tmax - 1:
        excess = par / (par_sat * 1.15)
        target = P.clamp(20 + (excess - 1) * 90 + (t - tmax) * 8, 20, 85)
        reasons.append(f"棚内光合有效辐射 {par:.0f} μmol/(m²·s)，达到{crop['name']}"
                       f"光饱和点 {par_sat:.0f} 的 {par / par_sat * 100:.0f}%")
        reasons.append(f"棚温 {_f(t)}℃ 同时逼近适温上限 {_f(tmax)}℃，光与温形成叠加胁迫")
        expected = f"削减约 {target * 0.72:.0f}% 的太阳辐射入射，棚温预计下降 1.5~3℃"
    elif par > par_sat * 1.35 and t > tmax - 3:
        target = 30.0
        reasons.append(f"强辐射（{par:.0f} μmol/(m²·s)）且棚温处于上行通道，提前展开遮阳削峰")
        expected = "降低太阳辐射峰值负荷，抑制棚温冲高"
    elif par < par_sat * 0.9 and z.act["shade"] > 5:
        reasons.append(f"当前光合有效辐射已降至 {par:.0f} μmol/(m²·s)，"
                       f"低于光饱和点 {par_sat:.0f}，继续遮阳会限制光合")

    prop.append(Proposal(
        zone=z.id, actuator="shade", value=target, priority=3, confidence=0.82,
        headline=(f"展开外遮阳 {target:.0f}%" if target > 0 else "收起外遮阳"),
        reasons=reasons,
        basis="R2 光温耦合调控：超过光饱和点后，光强不再转化为产量，只转化为热负荷；"
              "此时遮阳的降温收益大于光合损失。反之光不足时必须及时收网。",
        expected=expected, rule="R2",
    ))


def rule_fan_pad(z, crop, out: dict, prop: list[Proposal]):
    """R3 风机湿帘：只有外界湿球温度足够低时才划算。"""
    t = z.t_in
    _, tmax = temp_band(crop, out["is_night"])

    if t <= tmax + 2.5:
        prop.append(Proposal(
            zone=z.id, actuator="fan_pad", value=0, priority=2, confidence=0.7,
            headline="关闭风机湿帘",
            reasons=[] if t < tmax else [f"棚温 {_f(t)}℃，尚未超过湿帘启用的温差门槛"],
            basis="R3 湿帘启用的前提是常规通风已不足以压住温度；否则只增加能耗与湿度。",
            expected="节约风机电耗，避免不必要增湿", rule="R3"))
        return

    twb = P.wet_bulb(out["t_out"], out["rh_out"])
    gain = t - twb
    reasons = [f"棚温 {_f(t)}℃ 超适温上限 {_f(t - tmax)}℃，常规通风已压不住",
               f"室外干球 {_f(out['t_out'])}℃ / 湿球 {_f(twb)}℃，湿帘理论降温极限 {_f(gain)}℃"]

    if gain < 3.0 or z.rh_in > 92:
        reasons.append("降温潜力不足或棚内已接近饱和，湿帘增湿的代价大于降温收益")
        prop.append(Proposal(zone=z.id, actuator="fan_pad", value=0, priority=2,
                             confidence=0.7, headline="不启用湿帘", reasons=reasons,
                             basis="R3 湿帘有效性判据：干湿球温差小于 3℃ 时蒸发冷却效率过低。",
                             expected="避免无效能耗与高湿风险", rule="R3"))
        return

    target = P.clamp((t - tmax) * 16, 30, 100)
    prop.append(Proposal(
        zone=z.id, actuator="fan_pad", value=target, priority=2, confidence=0.86,
        headline=f"启用风机湿帘 {target:.0f}%",
        reasons=reasons,
        basis="R3 蒸发冷却：湿帘可将进风温度拉向室外湿球温度，是高温时段最有效的强制降温手段，"
              "但会同步抬升湿度，需与通风联调。",
        expected=f"进风温度预计下降 {min(gain * 0.75, t - tmax):.1f}℃，湿度上升 5~10 个百分点",
        rule="R3",
    ))


def rule_grow_light(z, crop, out: dict, prop: list[Proposal]):
    """R4 补光：按每日光积分缺口（DLI），而不是瞬时照度。"""
    hour = out["hour"]
    dli_target = crop["dli_target"]

    # 作物暗期熄灭（22:00–04:00），补光会打乱光周期
    if hour < 4 or hour > 20:
        prop.append(Proposal(
            zone=z.id, actuator="grow_light", value=0, priority=4, confidence=0.7,
            headline="关闭补光",
            reasons=["进入作物暗期（22:00–04:00），补光会干扰光周期与花芽分化"]
            if z.act["grow_light"] > 5 else [],
            basis="R4 光周期管理：连续照明会破坏短日照作物的花芽分化，暗期必须保证。",
            expected="保障暗期，节约电能", rule="R4"))
        return

    remaining_hours = max(0.0, min(12.0, 19.0 - hour))
    projected = z.dli_today + z.par_in * remaining_hours * 3600 / 1e6
    gap = dli_target - projected

    if z.par_in > 320 or gap < dli_target * 0.12:
        reasons = []
        if z.par_in > 320:
            reasons.append(f"当前棚内辐照 {z.par_in:.0f} μmol/(m²·s) 已能满足光合需求")
        else:
            reasons.append(f"今日累计光积分 {_f(z.dli_today)} mol/m²，"
                           f"按当前辐照推算日落前可达 {_f(projected)} mol/m²，"
                           f"接近{crop['name']}目标 {_f(dli_target)}")
        prop.append(Proposal(
            zone=z.id, actuator="grow_light", value=0, priority=4, confidence=0.75,
            headline="关闭补光", reasons=reasons,
            basis="R4 DLI 管理：自然光可满足时补光属无效能耗。",
            expected="节约电能", rule="R4"))
        return

    ratio = P.clamp(gap / (dli_target * 0.35), 0.25, 1.0)
    target = min(100.0, round(ratio * 100 / 5) * 5)
    prop.append(Proposal(
        zone=z.id, actuator="grow_light", value=target, priority=4, confidence=0.78,
        headline=f"开启补光 {target:.0f}%",
        reasons=[f"今日累计光积分 {_f(z.dli_today)} mol/m²，{crop['name']}目标 {_f(dli_target)} mol/m²",
                 f"按当前辐照推算日落前仅能补到 {_f(projected)} mol/m²，缺口 {_f(gap)} mol/m²",
                 f"当前辐照 {z.par_in:.0f} μmol/(m²·s)，尚未达到补光关闭阈值 320"],
        basis="R4 DLI 管理：以每日光积分作为补光依据，兼顾产量形成与能耗成本。",
        expected=f"补光 {target:.0f}%（约 {target * 1.7:.0f} μmol/m²/s），"
                 f"每小时补入 {target * 1.7 * 3600 / 1e6:.2f} mol/m²",
        rule="R4",
    ))


def rule_irrigation(z, crop, out: dict, prop: list[Proposal]):
    """R5 滴灌：基于根区水分亏缺，遵循 MAD 原则。"""
    if z._irrigation_pending > 0.1:
        return                                  # 上一次灌溉仍在执行，不重复下发

    vwc = crop["vwc"]
    lower, fc = vwc["lower"], vwc["field_capacity"]
    theta = z.vwc1
    if theta > lower:
        return

    target_theta = fc * 0.98
    deficit_mm = (target_theta - theta) / 100.0 * 200.0     # 0~20 cm 活性层
    dose = P.clamp(round(deficit_mm * 2) / 2, 1.0, 10.0)     # 单次 ≤10 mm，少量多次

    reasons = [f"根区含水率 {_f(theta)}%，已低于{crop['name']}灌溉触发线 "
               f"{_f(lower)}%（MAD 45% 对应的允许亏缺点）",
               f"田间持水量 {_f(fc)}%，理论补水亏缺 {_f(deficit_mm)} mm"]
    if out["et0"] > 3.2:
        reasons.append(f"当日参考蒸散 ET₀ 达 {_f(out['et0'])} mm，蒸发需求偏大，宜及时补水")
    if z.kind == "field" and out["rain"] > 0.5:
        reasons.append(f"当前有降雨（{_f(out['rain'])} mm/h），露地可适当延迟")

    prop.append(Proposal(
        zone=z.id, actuator="irrigation", value=dose, priority=2, confidence=0.92,
        headline=f"滴灌 {_f(dose)} mm",
        reasons=reasons,
        basis="R5 水分亏缺灌溉：在允许亏缺量（MAD）耗尽前补至田间持水量，"
              "既避免水分胁迫，又防止过量灌溉导致养分淋失与根区缺氧。",
        expected=f"根区含水率预计回升至 {_f(target_theta)}%，耗时约 {_f(dose / 5.0 * 60, 0)} min",
        rule="R5",
    ))


def rule_heater(z, crop, out: dict, prop: list[Proposal]):
    """R6 加温：防冷害。优先级高于一切降温措施。"""
    t = z.t_in
    abs_min = crop["temp"]["abs_min"]
    tmin, _ = temp_band(crop, out["is_night"])

    if t < abs_min + 2.0:
        target = P.clamp((abs_min + 2.5 - t) * 32, 35, 100)
        prop.append(Proposal(
            zone=z.id, actuator="heater", value=target, priority=1, confidence=0.95,
            headline=f"启动加温 {target:.0f}%",
            reasons=[f"棚内气温 {_f(t)}℃，逼近{crop['name']}冷害临界温度 {_f(abs_min)}℃",
                     f"室外 {_f(out['t_out'])}℃，若继续下探将造成不可逆冷害"],
            basis="R6 冷害防护：接近作物绝对最低温时优先保命，此时温度指标优先于能耗指标。",
            expected=f"预计 30 min 内回升至 {_f(abs_min + 2)}℃ 以上",
            rule="R6"))
    elif t < tmin - 3:
        target = P.clamp((tmin - 3 - t) * 22, 22, 75)
        prop.append(Proposal(
            zone=z.id, actuator="heater", value=target, priority=3, confidence=0.80,
            headline=f"温和加温 {target:.0f}%",
            reasons=[f"棚内气温 {_f(t)}℃，低于当前时段适温下限 {_f(tmin)}℃ 达 {_f(tmin - t)}℃",
                     "亚低温会抑制根系吸收与花芽分化，需温和补温而非猛加温"],
            basis="R6 亚低温调控：把温度托回适温区下沿即可，过度加温会造成徒长与能耗浪费。",
            expected="将棚温拉回适温区下沿，避免生长停滞",
            rule="R6"))
    else:
        prop.append(Proposal(
            zone=z.id, actuator="heater", value=0, priority=3, confidence=0.7,
            headline="关闭加温",
            reasons=[] if t > tmin else [f"棚内 {_f(t)}℃ 已在适温区下沿，无需加温"],
            basis="R6 亚低温调控：达到适温区即停止加温，把能耗留给真正需要的时段。",
            expected="节约加温能耗", rule="R6"))


def rule_co2(z, crop, out: dict, prop: list[Proposal]):
    """R7 CO₂ 施肥：通风关闭且光合活跃时才值得。"""
    opt = crop["co2_opt"]

    if z.par_in < 420:
        reason = ("夜间无光合作用，施气肥只会随呼吸与泄漏散失"
                  if z.par_in < 30 else f"辐照仅 {z.par_in:.0f} μmol/(m²·s)，光合速率低，施气效益不足")
        prop.append(Proposal(
            zone=z.id, actuator="co2_valve", value=0, priority=4, confidence=0.7,
            headline="关闭 CO₂ 施肥",
            reasons=[reason] if z.act["co2_valve"] > 5 else [],
            basis="R7 碳同化限制：只有在光合活跃且棚体密闭时，补充 CO₂ 才能转化为产量。",
            expected="节约气肥", rule="R7"))
        return

    if z.vent_effective() > 22:
        prop.append(Proposal(
            zone=z.id, actuator="co2_valve", value=0, priority=4, confidence=0.72,
            headline="暂停 CO₂ 施肥",
            reasons=[f"当前通风量 {z.vent_effective():.0f}%，施入的 CO₂ 会随换气迅速逸出，"
                     f"投入产出不划算"] if z.act["co2_valve"] > 5 else [],
            basis="R7 碳同化限制：开窗状态下施气肥等同于向大气排放。",
            expected="避免气肥浪费，待通风收小后恢复", rule="R7"))
        return

    if z.co2 > opt * 0.88:
        prop.append(Proposal(
            zone=z.id, actuator="co2_valve", value=0, priority=4, confidence=0.7,
            headline="关闭 CO₂ 施肥",
            reasons=[f"棚内 CO₂ 已达 {z.co2:.0f} ppm，接近{crop['name']}饱和点 {opt:.0f} ppm"]
            if z.act["co2_valve"] > 5 else [],
            basis="R7 碳同化限制：超过饱和点后继续施气不再提升净光合速率。",
            expected="节约气肥", rule="R7"))
        return

    gap = opt - z.co2
    target = P.clamp(gap / 3.5, 20, 100)
    prop.append(Proposal(
        zone=z.id, actuator="co2_valve", value=target, priority=4, confidence=0.72,
        headline=f"CO₂ 施肥 {target:.0f}%",
        reasons=[f"棚内 CO₂ 仅 {z.co2:.0f} ppm，低于{crop['name']}饱和点 {opt:.0f} ppm",
                 f"当前通风量 {z.vent_effective():.0f}%，棚体接近密闭，气肥不易外逸"],
        basis="R7 碳同化限制：密闭条件下 CO₂ 常被消耗至 350 ppm 以下而成为光合限制因子，"
              "适度补充可提升净光合速率 15%~30%。",
        expected=f"预计 20 min 内升至 {min(opt, z.co2 + gap * 0.4):.0f} ppm",
        rule="R7"))


def rule_storm_protect(z, crop, out: dict, prop: list[Proposal]):
    """R8 暴雨大风保护：关闭通风口防倒灌。优先级最高，可压过降温需求。"""
    if out["rain"] >= 8.0 or out["wind"] >= 10.0:
        cause = []
        if out["rain"] >= 8.0:
            cause.append(f"降雨强度 {_f(out['rain'])} mm/h")
        if out["wind"] >= 10.0:
            cause.append(f"风速 {_f(out['wind'])} m/s")
        prop.append(Proposal(
            zone=z.id, actuator="vent", value=0, priority=1, confidence=0.93,
            headline="关闭通风口防风防雨",
            reasons=[f"室外出现强天气：{'、'.join(cause)}",
                     "开窗状态下雨水倒灌会引发病害并损伤作物，大风可能撕裂棚膜"],
            basis="R8 灾害性天气防护：短时强天气优先保结构安全，暂停一切以降温为目的的通风。",
            expected="保护棚体与作物，天气转好后自动恢复温控逻辑",
            rule="R8"))


# =============================================================================
# 分区综合评估
# =============================================================================

def evaluate_zone(z, out: dict) -> list[Proposal]:
    """对一个分区跑完全部规则，返回原始建议列表（未做冲突消解）。"""
    crop = z.crop
    if crop is None or z.kind != "greenhouse":
        return []

    stage, _ = growth_stage(z.crop_key, out["month"])

    # 休眠期：作物不生长，不应加温、补光、施气肥，只做防冻与排水。
    if stage == "休眠期":
        props: list[Proposal] = []
        if z.t_in < crop["temp"]["abs_min"]:
            target = P.clamp((crop["temp"]["abs_min"] + 1.0 - z.t_in) * 30, 30, 80)
            props.append(Proposal(
                zone=z.id, actuator="heater", value=target, priority=1, confidence=0.9,
                headline=f"防冻加温 {target:.0f}%",
                reasons=[f"{crop['name']}处于休眠期，棚温 {_f(z.t_in)}℃ 已跌破越冬安全下限 "
                         f"{_f(crop['temp']['abs_min'])}℃",
                         "休眠期只需防止根系冻害，无需维持生长适温"],
                basis="芍药越冬：地下芽可耐 -10℃ 左右低温，管理核心是控水防烂根与极低温防护，"
                      "持续加温既无必要也显著推高能耗。",
                expected="将棚温托底至安全温度，避免根芽冻伤",
                rule="R6"))
        elif z.act["heater"] > 0:
            props.append(Proposal(
                zone=z.id, actuator="heater", value=0, priority=3, confidence=0.8,
                headline="关闭加温",
                reasons=[f"{crop['name']}处于休眠期，棚温 {_f(z.t_in)}℃ 在越冬安全范围内"],
                basis="芍药越冬：休眠期无需维持生长适温。",
                expected="大幅降低冬季加温能耗", rule="R6"))

        if z.vwc1 > crop["vwc"]["upper"]:
            props.append(Proposal(
                zone=z.id, actuator="vent", value=45, priority=3, confidence=0.75,
                headline="通风排湿 45%",
                reasons=[f"休眠期根区含水率 {_f(z.vwc1)}%，高于 {_f(crop['vwc']['upper'])}% 上限",
                         "冬季土壤长期过湿是芍药烂根的首要诱因"],
                basis="芍药越冬控水：休眠期保持土壤偏干，可显著降低越冬腐烂率。",
                expected="降低根区含水量，减少越冬病害",
                rule="R1"))
        elif z.rh_in > 92:
            props.append(Proposal(
                zone=z.id, actuator="vent", value=30, priority=3, confidence=0.72,
                headline="通风排湿 30%",
                reasons=[f"棚内相对湿度 {_f(z.rh_in, 0)}%，覆盖层持续结露",
                         "休眠期虽不生长，但长期高湿会加速棚膜与骨架锈蚀，并诱发根茎腐烂"],
                basis="R1 休眠期排湿：低温高湿环境下，排湿的收益主要在于抑制病原与保护设施，"
                      "而非作物生理需求。",
                expected="相对湿度降至 90% 以下，减少夜间结露时长",
                rule="R1"))
        elif z.act["vent"] > 0:
            props.append(Proposal(
                zone=z.id, actuator="vent", value=0, priority=3, confidence=0.7,
                headline="关闭通风",
                reasons=[], basis="R1 休眠期以保温控水为主。",
                expected="减少热量散失", rule="R1"))
        return props

    props = []
    rule_heater(z, crop, out, props)        # 优先级 1，先算
    rule_storm_protect(z, crop, out, props)
    rule_vent(z, crop, out, props)
    rule_fan_pad(z, crop, out, props)
    rule_shade(z, crop, out, props)
    rule_grow_light(z, crop, out, props)
    rule_co2(z, crop, out, props)
    rule_irrigation(z, crop, out, props)
    return props


def health_score(z, month: int | None = None, is_night: bool = False) -> tuple[float, list[str]]:
    """
    分区健康度（0~100）与扣分原因。
    把多维指标压成一个可读数字，用于大屏分区状态条。
    判据随物候期与昼夜变化，避免"休眠期低温"这类伪告警。
    """
    crop = z.crop
    if crop is None:
        return 100.0, []

    stage = growth_stage(z.crop_key, month)[0] if month else ""
    dormant = stage == "休眠期"

    score = 100.0
    issues: list[str] = []

    tmin, tmax = temp_band(crop, is_night)
    abs_min = crop["temp"]["abs_min"]

    if dormant:
        if z.t_in < abs_min:
            d = min(30.0, (abs_min - z.t_in) * 8)
            score -= d
            issues.append(f"冻害风险 -{d:.0f}")
        if z.vwc1 > crop["vwc"]["upper"] + 2:
            d = min(18.0, (z.vwc1 - crop["vwc"]["upper"]) * 4)
            score -= d
            issues.append(f"根区过湿 -{d:.0f}")
    else:
        if z.t_in > tmax:
            d = min(30.0, (z.t_in - tmax) * 7)
            score -= d
            issues.append(f"高温胁迫 -{d:.0f}")
        elif z.t_in < tmin:
            d = min(30.0, (tmin - z.t_in) * 6)
            score -= d
            issues.append(f"低温胁迫 -{d:.0f}")

        if z.vwc1 < crop["vwc"]["lower"]:
            d = min(25.0, (crop["vwc"]["lower"] - z.vwc1) * 6)
            score -= d
            issues.append(f"水分亏缺 -{d:.0f}")
        elif z.vwc1 > crop["vwc"]["upper"]:
            d = min(15.0, (z.vwc1 - crop["vwc"]["upper"]) * 4)
            score -= d
            issues.append(f"根区过湿 -{d:.0f}")

        vlo, vhi = crop["vpd"]["opt_min"], crop["vpd"]["opt_max"]
        if z.vpd_in > vhi * 1.5:
            d = min(12.0, (z.vpd_in - vhi) * 6)
            score -= d
            issues.append(f"空气过干 -{d:.0f}")
        elif z.vpd_in < vlo * 0.5:
            d = min(10.0, (vlo - z.vpd_in) * 10)
            score -= d
            issues.append(f"湿度过高 -{d:.0f}")

        if z.soil_ph < crop["ph"]["min"] or z.soil_ph > crop["ph"]["max"]:
            score -= 6
            issues.append("pH 偏离 -6")
        if z.soil_ec > crop["ec"]["max"]:
            score -= 5
            issues.append("EC 偏高 -5")

    return max(0.0, min(100.0, score)), issues
