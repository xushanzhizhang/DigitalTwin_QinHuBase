# -*- coding: utf-8 -*-
"""
决策 Agent 调度引擎
===================

职责边界
--------
  rules.py   —— "懂农艺"：给出原始建议（可能互相冲突）
  engine.py  —— "懂调度"：冲突消解、迟滞控制、安全复核、下发与留痕

三种运行模式
------------
  auto    全自动：Agent 直接下发指令（默认）
  advise  建议模式：只生成建议与理由，不动作，由人确认
  manual  手动：Agent 静默，全部由操作员控制

为什么要做迟滞控制
------------------
比例控制直接照着阈值走，在阈值附近会 1 秒开关十次（执行机构寿命杀手）。
这里给每个执行器设死区，只有目标值与当前值差异超过死区才下发新指令。
"""

from __future__ import annotations

import time
from collections import deque

from .. import config as C
from . import rules as R
from ..sensors import physics as P


class DecisionEngine:
    """决策 Agent。"""

    def __init__(self, simulator, mode: str = "auto",
                 tick_interval: float = 120.0, max_log: int = 400):
        self.sim = simulator
        self.mode = mode
        self.tick_interval = tick_interval        # 以仿真秒计的决策周期
        self._next_tick = 0.0
        self.log: deque[dict] = deque(maxlen=max_log)
        self.mode_since = time.time()
        self._seq = 0

        # 执行器死区（避免阈值附近抖动）
        self.deadband = {
            "vent": 10.0, "shade": 10.0, "fan_pad": 12.0,
            "grow_light": 12.0, "heater": 10.0, "co2_valve": 12.0,
        }
        # 最短保持时间（仿真秒）：指令下发后至少维持这么久才允许再次调整，
        # 保护卷膜机、风机这类执行机构的寿命
        self.min_dwell = {
            "vent": 600.0, "shade": 1200.0, "fan_pad": 900.0,
            "grow_light": 1800.0, "heater": 1200.0, "co2_valve": 1800.0,
        }
        self._last_cmd: dict[tuple[str, str], float] = {}
        self._last_log: dict[tuple[str, str], float] = {}
        self.action_count = 0          # 全部执行动作数（含未留痕的比例调节）
        # 统计
        self.stats = {"total": 0, "auto_applied": 0, "advisory": 0, "zones": {}}

    # ------------------------------------------------------------------
    def _out_context(self) -> dict:
        env = self.sim.environment()
        return {
            "is_night": env["solar_elevation"] <= 0,
            "hour": env["hour"],
            "month": self.sim.now().month,
            "t_out": env["outdoor_temp"],
            "rh_out": env["outdoor_humidity"],
            "rain": env["rain"],
            "wind": env["wind"],
            "et0": env["et0"],
            "ghi": env["ghi"],
        }

    # ------------------------------------------------------------------
    def tick(self, force: bool = False) -> list[dict]:
        """按仿真时间节拍运行一次决策。返回本次新产生的决策记录。"""
        if not force and self.sim.ts < self._next_tick:
            return []
        self._next_tick = self.sim.ts + self.tick_interval

        if self.mode == "manual":
            return []

        out = self._out_context()
        emitted: list[dict] = []

        for zid, z in self.sim.zones.items():
            if z.kind != "greenhouse":
                continue
            proposals = R.evaluate_zone(z, out)
            resolved = self._resolve(proposals)
            for actuator, prop in resolved.items():
                rec = self._apply(z, actuator, prop, out)
                if rec:
                    emitted.append(rec)

        return emitted

    # ------------------------------------------------------------------
    def _resolve(self, proposals: list[R.Proposal]) -> dict[str, R.Proposal]:
        """
        冲突消解：同一执行器有多条建议时，取优先级数字最小（最高）者；
        同优先级取置信度高者。这样"关闭通风防暴雨"能压过"开窗降温"。
        """
        best: dict[str, R.Proposal] = {}
        for p in proposals:
            cur = best.get(p.actuator)
            if cur is None or (p.priority, -p.confidence) < (cur.priority, -cur.confidence):
                best[p.actuator] = p
        return best

    # ------------------------------------------------------------------
    def _apply(self, z, actuator: str, prop: R.Proposal, out: dict) -> dict | None:
        """量化 → 死区 → 保持时间 → 下发（或仅记录）→ 生成留痕记录。"""
        current = z.act.get(actuator, 0.0)

        # ① 指令量化到 5% 档位，避免"37.4% → 38.9%"这类无意义微调
        if C.ACTUATORS[actuator]["unit"] == "%":
            target = round(prop.value / 5.0) * 5.0
        else:
            target = round(prop.value * 2) / 2.0        # 灌溉量 0.5 mm 一档

        # ② 死区与边沿判断：从 0 起步或回到 0 必须执行，否则永远关不掉
        band = self.deadband.get(actuator, 0.0)
        changed = abs(target - current) > band
        if (current <= 0.01 and target > 0) or (target <= 0.01 and current > 0.01):
            changed = True
        if actuator == "irrigation":
            changed = target > 0

        if not changed:
            return None

        # ③ 最短保持时间：除非是"紧急"级指令，否则不让执行器频繁动作
        key = (z.id, actuator)
        dwell = self.min_dwell.get(actuator, 0.0)
        if prop.priority > 1 and (self.sim.ts - self._last_cmd.get(key, -1e18)) < dwell:
            return None
        self._last_cmd[key] = self.sim.ts

        applied = False
        if self.mode == "auto":
            self.sim.set_actuator(z.id, actuator, target)
            applied = True
            self.stats["auto_applied"] += 1
        else:
            self.stats["advisory"] += 1
        self.action_count += 1

        # ④ 留痕筛选：比例调节每 15 分钟就会产生一条，全记下来会把真正重要的
        #    决策淹没。只保留"值得复盘"的动作：起停、高优先级、或大幅调整。
        crossed = (current <= 0.01) != (target <= 0.01)
        notable = crossed or prop.priority <= 2 or abs(target - current) >= 25
        if not notable:
            return None
        # 同一分区同一执行器的留痕最短间隔 30 min（紧急级除外），防止信息流刷屏
        log_key = (z.id, actuator)
        if prop.priority > 1 and (self.sim.ts - self._last_log.get(log_key, -1e18)) < 1800.0:
            return None
        self._last_log[log_key] = self.sim.ts

        self._seq += 1
        self.stats["total"] += 1
        self.stats["zones"][z.id] = self.stats["zones"].get(z.id, 0) + 1

        # 地块健康度快照，便于前端把"决策"与"后果"对应起来
        health, issues = R.health_score(z, self.sim.now().month, out["is_night"])

        rec = {
            "id": f"D{self._seq:05d}",
            "ts": self.sim.ts,
            "time": self.sim.now().strftime("%H:%M"),
            "datetime": self.sim.now().strftime("%m-%d %H:%M:%S"),
            "zone": z.id,
            "zone_name": C.ZONES[z.id]["name"],
            "crop_name": z.crop["name"] if z.crop else "",
            "actuator": actuator,
            "actuator_label": C.ACTUATORS[actuator]["label"],
            "unit": C.ACTUATORS[actuator]["unit"],
            "value": round(target, 1),
            "prev": round(current, 1),
            "priority": prop.priority,
            "priority_label": {1: "紧急", 2: "重要", 3: "优化", 4: "节能"}.get(prop.priority, "一般"),
            "confidence": prop.confidence,
            "headline": prop.headline,
            "reasons": prop.reasons,
            "basis": prop.basis,
            "expected": prop.expected,
            "rule": prop.rule,
            "applied": applied,
            "health": round(health, 1),
            "health_issues": issues,
        }
        self.log.appendleft(rec)
        return rec

    # ------------------------------------------------------------------
    def snapshot(self) -> dict:
        """给前端的 Agent 面板数据。"""
        zone_cards = []
        out = self._out_context()
        for zid, z in self.sim.zones.items():
            if z.kind != "greenhouse":
                continue
            health, issues = R.health_score(z, self.sim.now().month, out["is_night"])
            crop = z.crop
            stage, note = R.growth_stage(z.crop_key, self.sim.now().month)
            # 当前"待办"：跑一遍规则，取尚未满足的建议作为建议列表
            pending = []
            for p in self._resolve(R.evaluate_zone(z, out)).values():
                if abs(p.value - z.act.get(p.actuator, 0)) > (self.deadband.get(p.actuator, 5) * 0.5):
                    pending.append(p.to_dict())
            pending.sort(key=lambda d: d["priority"])

            zone_cards.append({
                "zone": zid,
                "name": C.ZONES[zid]["name"],
                "crop": crop["name"] if crop else "",
                "stage": stage,
                "stage_note": note,
                "health": round(health, 1),
                "issues": issues,
                "pending": pending,
                "dli": round(z.dli_today, 1),
                "dli_target": crop["dli_target"] if crop else 0,
                "summary": self._narrate(z, health, issues, stage, out["is_night"]),
            })

        return {
            "mode": self.mode,
            "tick_interval": self.tick_interval,
            "stats": {
                "total": self.stats["total"],
                "applied": self.stats["auto_applied"],
                "advisory": self.stats["advisory"],
                "actions": self.action_count,
            },
            "recent": list(self.log)[:40],
            "zones": zone_cards,
            "engine": "规则知识库 + 多目标寻优（可解释）",
        }

    # ------------------------------------------------------------------
    def _narrate(self, z, health: float, issues: list[str], stage: str,
                 is_night: bool) -> str:
        """
        生成一段"农艺师口吻"的现状描述。
        刻意不用模板化的 AI 腔，句式长短交错，贴近基地技术员写日志的习惯。
        判据跟随昼夜与物候期 —— 休眠期不该说"低温抑制生长"，夜里也不该拿白天适温要求夜间。
        """
        crop = z.crop
        if crop is None:
            return ""
        name = crop["name"]
        parts: list[str] = []

        if stage == "休眠期":
            parts.append(f"{name}正处休眠期，地上部已经枯萎，管理重点转为控水防烂根与极低温防护")
            if z.vwc1 > crop["vwc"]["upper"]:
                parts.append(f"根区含水率 {z.vwc1:.1f}% 偏高，冬季久湿最容易沤根，需要排湿")
            elif z.vwc1 < crop["vwc"]["lower"] * 0.8:
                parts.append(f"根区含水率 {z.vwc1:.1f}% 偏干，但休眠期本就要求偏干，暂不补水")
            if z.rh_in > 92:
                parts.append(f"棚内湿度 {z.rh_in:.0f}%，覆盖层整夜结露，设施锈蚀和根茎腐烂风险上升")
            lead = ""
        else:
            tmin, tmax = R.temp_band(crop, is_night)
            when = "夜间" if is_night else "白天"
            if z.t_in > tmax:
                parts.append(f"棚内 {z.t_in:.1f}℃，已经压过{when}适温上限 "
                             f"{tmax:.0f}℃ 一截")
            elif z.t_in < tmin:
                parts.append(f"棚温只有 {z.t_in:.1f}℃，低于{when}适温下限 "
                             f"{tmin:.0f}℃，根系吸收会明显变慢")
            else:
                parts.append(f"棚温 {z.t_in:.1f}℃，落在{name}{when}适温区里")

            if z.vpd_in > crop["vpd"]["opt_max"] * 1.4:
                parts.append(f"空气 VPD 到 {z.vpd_in:.2f} kPa，干得有点狠，"
                             f"气孔会主动关小，光合反而上不去")
            elif z.vpd_in < crop["vpd"]["opt_min"] * 0.6:
                parts.append(f"VPD 只有 {z.vpd_in:.2f} kPa，湿闷，"
                             f"这种条件最招灰霉和霜霉")

            if z.vwc1 < crop["vwc"]["lower"]:
                parts.append(f"根区含水率掉到 {z.vwc1:.1f}%，已经越过亏缺警戒线，得补水了")
            elif z.vwc1 > crop["vwc"]["upper"]:
                parts.append(f"根区含水率 {z.vwc1:.1f}% 偏高，注意别沤根")
            lead = f"当前处于{stage}。"

        body = "；".join(parts) + "。"
        if health >= 85:
            tail = f"综合健康度 {health:.0f}，状态稳定。"
        elif health >= 70:
            tail = f"综合健康度 {health:.0f}，{'、'.join(issues)}，需要盯一下。"
        else:
            tail = f"综合健康度只有 {health:.0f}，{'、'.join(issues)}，建议人工介入。"
        return lead + body + tail
