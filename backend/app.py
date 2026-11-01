# -*- coding: utf-8 -*-
"""
琴湖基地智慧农业数字孪生 —— 后端服务
====================================

一个进程干三件事：
  1. 跑仿真内核（backend.sensors.Simulator）与决策 Agent（backend.agent.DecisionEngine）
  2. 通过 WebSocket 把孪生帧推给前端，接收前端下发的控制指令
  3. 提供 REST 接口（站点配置 / 历史曲线 / 决策留痕）

启动：
    python -m backend.app
或：
    uvicorn backend.app:app --host 127.0.0.1 --port 8848
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config as C
from .agent.engine import DecisionEngine
from .agent import rules as R
from .sensors.simulator import Simulator
from .store import Store

# ---------------------------------------------------------------------------
# 运行参数
# ---------------------------------------------------------------------------
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "frontend")
DB_PATH = os.environ.get("TWIN_DB", "data/twin.db")
SEED_HOURS = float(os.environ.get("TWIN_SEED_HOURS", "24"))
# 演示/截图时可用环境变量锁定起始时刻（小时，支持小数，如 9.5）与倍速
START_HOUR = os.environ.get("TWIN_START_HOUR", "")
DEFAULT_SPEED = float(os.environ.get("TWIN_SPEED", "60"))
TICK_HZ = 8.0                 # 仿真步进频率
SAMPLE_SECONDS = 60.0         # 每隔多少仿真秒落一次盘


class TwinRuntime:
    """把仿真、Agent、存储、广播串起来。"""

    def __init__(self):
        self.store = Store(DB_PATH)
        self.sim: Simulator | None = None
        self.agent: DecisionEngine | None = None
        self.clients: set[WebSocket] = set()
        self.running = False
        self._last_sample_ts = 0.0
        self._last_agent_push = 0.0
        self._new_decisions: list[dict] = []
        self._task: asyncio.Task | None = None

    # ------------------------------------------------------------------
    def bootstrap(self, scenario: str = "sunny"):
        """
        建立仿真内核，并回放 SEED_HOURS 小时历史，让大屏一打开就有曲线。

        起始时刻的处理：真实部署应当跟随真实时间，但演示场景下如果恰好在深夜，
        打开大屏只能看到一片漆黑，讲解效果很差。因此当真实时间落在 07:00–17:00
        之外时，把仿真起点挪到当天 09:30，让画面处在白天。
        """
        from datetime import datetime, timedelta
        real = datetime.now()
        if START_HOUR:
            hh = float(START_HOUR)
            anchor = real.replace(hour=int(hh), minute=int((hh % 1) * 60),
                                  second=0, microsecond=0)
            now = anchor.timestamp()
        elif not (7 <= real.hour < 17):
            anchor = real.replace(hour=9, minute=30, second=0, microsecond=0)
            if anchor > real:
                anchor -= timedelta(days=1)
            now = anchor.timestamp()
        else:
            now = time.time()
        start = now - SEED_HOURS * 3600
        self.sim = Simulator(start_ts=start, seed=20260825, scenario=scenario)
        self.agent = DecisionEngine(self.sim, mode="auto", tick_interval=120.0)

        # 清空旧数据，保证每次启动的历史都是干净的
        with self.store._lock:
            self.store.conn.execute("DELETE FROM zone_samples")
            self.store.conn.execute("DELETE FROM weather_samples")
            self.store.conn.execute("DELETE FROM decisions")
            self.store.conn.commit()

        # 回放：每 30 s 仿真步长推进，每 60 s 落盘一次
        total = int(SEED_HOURS * 3600 / 30)
        for i in range(total):
            self.sim.step(30.0, speed=1.0)
            for rec in self.agent.tick():
                self.store.add_decision(rec)
            if (i * 30) % SAMPLE_SECONDS < 30:
                self._persist(self.sim.ts)
        self.store.flush(force=True)
        self.sim.speed = DEFAULT_SPEED
        self._last_sample_ts = self.sim.ts

    # ------------------------------------------------------------------
    def _persist(self, ts: float):
        if self.sim is None:
            return
        for zid, snap in self.sim.get_states().items():
            self.store.add_zone(ts, snap)
        self.store.add_weather(ts, self.sim.environment())

    # ------------------------------------------------------------------
    def build_frame(self) -> dict:
        sim = self.sim
        agent = self.agent
        env = sim.environment()
        states = sim.get_states()

        # ---- 告警：把"指标越界"翻译成人能看懂的一句话 ----
        alarms = []
        for zid, z in sim.zones.items():
            crop = z.crop
            if crop is None:
                continue
            stage = R.growth_stage(z.crop_key, sim.now().month)[0]
            if stage == "休眠期":
                if z.t_in < crop["temp"]["abs_min"]:
                    alarms.append({"zone": zid, "level": "high",
                                   "text": f"{C.ZONES[zid]['name']}棚温 {z.t_in:.1f}℃ 低于越冬安全下限"})
                continue
            is_night = env["solar_elevation"] <= 0
            tmin, tmax = R.temp_band(crop, is_night)
            if z.t_in > tmax + 2:
                alarms.append({"zone": zid, "level": "high",
                               "text": f"{C.ZONES[zid]['name']}气温 {z.t_in:.1f}℃，超适温上限 {tmax:.0f}℃"})
            elif z.t_in < tmin - 3:
                alarms.append({"zone": zid, "level": "medium",
                               "text": f"{C.ZONES[zid]['name']}气温 {z.t_in:.1f}℃，低于适温下限 {tmin:.0f}℃"})
            if z.vwc1 < crop["vwc"]["wilting"]:
                alarms.append({"zone": zid, "level": "high",
                               "text": f"{C.ZONES[zid]['name']}根区含水率 {z.vwc1:.1f}%，已近萎蔫点"})
            elif z.vwc1 < crop["vwc"]["lower"]:
                alarms.append({"zone": zid, "level": "medium",
                               "text": f"{C.ZONES[zid]['name']}根区含水率 {z.vwc1:.1f}%，低于灌溉触发线"})
            if z.rh_in > 92:
                alarms.append({"zone": zid, "level": "low",
                               "text": f"{C.ZONES[zid]['name']}相对湿度 {z.rh_in:.0f}%，结露风险高"})

        # ---- 关键指标 ----
        energy = sum(z.energy_kwh for z in sim.zones.values())
        water = sum(z.water_l for z in sim.zones.values())
        active = sum(1 for z in sim.zones.values()
                     for k, v in z.act.items() if v > 1)
        nodes = sim.readings()
        online = sum(1 for n in nodes.values() if n.online)
        healths = []
        for zid, z in sim.zones.items():
            if z.kind != "greenhouse":
                continue
            is_night = env["solar_elevation"] <= 0
            h, _ = R.health_score(z, sim.now().month, is_night)
            healths.append(h)

        return {
            "type": "frame",
            "ts": round(sim.ts, 2),
            "env": env,
            "zones": states,
            "nodes": {nid: {k: round(v, 2) for k, v in n.values.items()}
                      for nid, n in nodes.items()},
            "kpi": {
                "avg_health": round(sum(healths) / len(healths), 1) if healths else 100,
                "energy_kwh": round(energy, 1),
                "water_l": round(water, 0),
                "online_rate": round(online / max(1, len(nodes)) * 100, 1),
                "node_total": len(nodes),
                "active_actuators": active,
                "alarm_count": len(alarms),
                "decision_count": agent.stats["total"] if agent else 0,
                "action_count": agent.action_count if agent else 0,
            },
            "alarms": alarms[:8],
        }

    # ------------------------------------------------------------------
    async def broadcast(self, msg: dict):
        if not self.clients:
            return
        data = json.dumps(msg, ensure_ascii=False)
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    # ------------------------------------------------------------------
    async def run_loop(self):
        self.running = True
        dt = 1.0 / TICK_HZ
        last = time.perf_counter()
        while self.running:
            now = time.perf_counter()
            elapsed = now - last
            last = now
            # 卡顿时不追赶，直接跳过，避免雪崩
            elapsed = min(elapsed, 0.5)

            self.sim.step(elapsed, self.sim.speed)
            for rec in self.agent.tick():
                self.store.add_decision(rec)

            # 采样落盘
            if self.sim.ts - self._last_sample_ts >= SAMPLE_SECONDS:
                self._last_sample_ts = self.sim.ts
                self._persist(self.sim.ts)
                self.store.flush()

            # 高频帧：驱动三维场景与仪表
            await self.broadcast(self.build_frame())

            # 低频：Agent 面板（含完整推理链），2 秒一次
            if self.sim.ts - self._last_agent_push >= 2.0:
                self._last_agent_push = self.sim.ts
                snap = self.agent.snapshot()
                await self.broadcast({"type": "agent", "agent": snap})

            await asyncio.sleep(max(0.0, dt - (time.perf_counter() - now)))

    # ------------------------------------------------------------------
    def apply_command(self, cmd: dict) -> dict:
        """处理前端指令。"""
        action = cmd.get("action")
        try:
            if action == "set_speed":
                self.sim.speed = max(0.0, min(3600.0, float(cmd["value"])))
                return {"ok": True, "speed": self.sim.speed}
            if action == "set_mode":
                mode = cmd["value"]
                if mode in ("auto", "advise", "manual"):
                    self.agent.mode = mode
                    self.agent.mode_since = time.time()
                    return {"ok": True, "mode": mode}
                return {"ok": False, "error": "非法模式"}
            if action == "set_actuator":
                zid, key, val = cmd["zone"], cmd["actuator"], float(cmd["value"])
                res = self.sim.set_actuator(zid, key, val)
                # 手动操作后，让 Agent 的保持计时器重新起算，避免互相打架
                self.agent._last_cmd[(zid, key)] = 0.0
                return res
            if action == "set_scenario":
                self.sim.weather.apply_scenario(cmd["value"])
                return {"ok": True, "scenario": cmd["value"]}
            if action == "seek":
                # 时间跳转（演示用）：向前推进指定小时数
                hours = float(cmd.get("hours", 1))
                self.sim.step(hours * 3600.0, speed=1.0)
                return {"ok": True, "ts": self.sim.ts}
            return {"ok": False, "error": "未知指令"}
        except Exception as e:                                  # noqa: BLE001
            return {"ok": False, "error": str(e)}


rt = TwinRuntime()


# ---------------------------------------------------------------------------
# 应用
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    rt.bootstrap()
    task = asyncio.create_task(rt.run_loop())
    print(f"[twin] 服务已启动  仿真时刻 {rt.sim.now():%Y-%m-%d %H:%M}  "
          f"历史 {SEED_HOURS:.0f} h")
    yield
    rt.running = False
    task.cancel()
    rt.store.close()


app = FastAPI(title="琴湖基地智慧农业数字孪生", version="1.0", lifespan=lifespan)


@app.get("/api/site")
async def api_site():
    """站点拓扑：分区、传感器节点、作物参数、指标字典。前端据此绘制与标注。"""
    return {
        "site": C.SITE,
        "zones": C.ZONES,
        "nursery": C.NURSERY_NORTH,
        "nodes": C.SENSOR_NODES,
        "metrics": C.METRICS,
        "crops": C.CROPS,
        "actuators": C.ACTUATORS,
    }


@app.get("/api/history")
async def api_history(minutes: int = Query(360, ge=10, le=10080),
                      zone: str | None = None):
    return rt.store.history(minutes=minutes, zone=zone,
                            now_ts=rt.sim.ts if rt.sim else None)


@app.get("/api/decisions")
async def api_decisions(limit: int = Query(100, ge=1, le=1000)):
    return rt.store.decisions(limit=limit)


@app.get("/api/state")
async def api_state():
    return {
        "env": rt.sim.environment(),
        "zones": rt.sim.get_states(),
        "agent": rt.agent.snapshot(),
        "kpi": rt.build_frame()["kpi"],
        "store": rt.store.stats(),
    }


@app.get("/api/health")
async def api_health():
    return {"ok": True, "ts": rt.sim.ts if rt.sim else 0}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    rt.clients.add(ws)
    try:
        # 建连即推一帧完整状态，避免前端出现空白等待
        await ws.send_text(json.dumps(rt.build_frame(), ensure_ascii=False))
        await ws.send_text(json.dumps({"type": "agent", "agent": rt.agent.snapshot()},
                                      ensure_ascii=False))
        await ws.send_text(json.dumps({"type": "site_ready"}, ensure_ascii=False))
        while True:
            raw = await ws.receive_text()
            try:
                cmd = json.loads(raw)
            except json.JSONDecodeError:
                continue
            res = rt.apply_command(cmd)
            if cmd.get("action") == "set_actuator":
                res["echo"] = cmd
            await ws.send_text(json.dumps({"type": "ack", **res}, ensure_ascii=False))
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        rt.clients.discard(ws)


# 三维模型资产（用户在 Blender/脚本里建的 glb）单独挂一个路由：
# 这样模型文件仍留在《场景图及建模要求/建模》里作为唯一数据源，
# 以后重新导出 glb 只要覆盖原文件，前端刷新就能看到，不必再拷一份到 frontend。
MODEL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "场景图及建模要求", "建模")
if os.path.isdir(MODEL_DIR):
    app.mount("/assets/model", StaticFiles(directory=MODEL_DIR), name="model-assets")

# 静态资源放最后，避免覆盖 /api 路由
if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


def main():
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8848, log_level="info")


if __name__ == "__main__":
    main()
