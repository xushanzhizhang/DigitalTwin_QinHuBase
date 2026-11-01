# -*- coding: utf-8 -*-
"""
时序存储
========

用 SQLite（WAL 模式）落盘，理由很朴素：单机部署、零运维、够快。
一个基地 5 个分区、每 60 秒一个采样点，一年也就 260 万行，SQLite 完全扛得住。

表设计
------
  zone_samples   分区环境快照（宽表，便于画曲线时一次取回所有指标）
  weather_samples 室外气象快照
  decisions      决策留痕（含完整推理链 JSON）

宽表而非窄表（一行一个测点）是刻意的：大屏只需要"某分区某时间段内的趋势"，
宽表一次查询就能拿到，省掉大量行转列的麻烦。
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time


DDL = """
CREATE TABLE IF NOT EXISTS zone_samples (
    ts REAL NOT NULL,
    zone TEXT NOT NULL,
    air_temp REAL, air_humidity REAL, vpd REAL, co2 REAL, par REAL,
    soil_temp REAL, soil_moisture REAL, soil_ph REAL, soil_ec REAL,
    dli REAL, energy_kwh REAL,
    vent REAL, shade REAL, fan_pad REAL, grow_light REAL, heater REAL,
    PRIMARY KEY (ts, zone)
);
CREATE INDEX IF NOT EXISTS idx_zone_ts ON zone_samples(zone, ts);

CREATE TABLE IF NOT EXISTS weather_samples (
    ts REAL PRIMARY KEY,
    t_out REAL, rh_out REAL, ghi REAL, par REAL, wind REAL, rain REAL, et0 REAL
);

CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    ts REAL NOT NULL,
    zone TEXT, actuator TEXT, value REAL,
    payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_dec_ts ON decisions(ts);
"""


class Store:
    def __init__(self, path: str = "data/twin.db"):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self.path = path
        self._lock = threading.Lock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.executescript(DDL)
        self.conn.commit()
        self._pending_zones: list[tuple] = []
        self._pending_wx: list[tuple] = []
        self._pending_dec: list[tuple] = []
        self.last_flush = 0.0

    # ------------------------------------------------------------------
    def add_zone(self, ts: float, snap: dict):
        a = snap.get("actuators", {})
        self._pending_zones.append((
            ts, snap["id"], snap.get("air_temp"), snap.get("air_humidity"),
            snap.get("vpd"), snap.get("co2"), snap.get("par"),
            snap.get("soil_temp"), snap.get("soil_moisture"),
            snap.get("soil_ph"), snap.get("soil_ec"), snap.get("dli"),
            snap.get("energy_kwh"),
            a.get("vent"), a.get("shade"), a.get("fan_pad"),
            a.get("grow_light"), a.get("heater"),
        ))

    def add_weather(self, ts: float, env: dict):
        self._pending_wx.append((
            ts, env.get("outdoor_temp"), env.get("outdoor_humidity"),
            env.get("ghi"), env.get("par"), env.get("wind"),
            env.get("rain"), env.get("et0"),
        ))

    def add_decision(self, rec: dict):
        self._pending_dec.append((
            rec["id"], rec["ts"], rec["zone"], rec["actuator"],
            rec["value"], json.dumps(rec, ensure_ascii=False),
        ))

    # ------------------------------------------------------------------
    def flush(self, force: bool = False):
        """批量提交，避免每个采样点都 fsync。"""
        now = time.time()
        if not force and now - self.last_flush < 2.0:
            return
        if not (self._pending_zones or self._pending_wx or self._pending_dec):
            self.last_flush = now
            return
        with self._lock:
            try:
                if self._pending_zones:
                    self.conn.executemany(
                        "INSERT OR REPLACE INTO zone_samples VALUES "
                        "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", self._pending_zones)
                    self._pending_zones.clear()
                if self._pending_wx:
                    self.conn.executemany(
                        "INSERT OR REPLACE INTO weather_samples VALUES (?,?,?,?,?,?,?,?)",
                        self._pending_wx)
                    self._pending_wx.clear()
                if self._pending_dec:
                    self.conn.executemany(
                        "INSERT OR REPLACE INTO decisions VALUES (?,?,?,?,?,?)",
                        self._pending_dec)
                    self._pending_dec.clear()
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                self._pending_zones.clear()
                self._pending_wx.clear()
                self._pending_dec.clear()
        self.last_flush = now

    # ------------------------------------------------------------------
    def history(self, minutes: int = 360, zone: str | None = None,
                max_points: int = 240, now_ts: float | None = None) -> dict:
        """
        取一段时间的分区曲线。超过 max_points 时按等间隔抽样，
        保证传到前端的数据量可控（大屏不需要 1440 个点）。

        now_ts 必须传仿真时刻：样本的时间戳来自仿真时钟，而演示时仿真时钟
        可能领先或落后真实时间数小时，用 time.time() 过滤会把数据全筛掉。
        """
        now = now_ts if now_ts is not None else time.time()
        since = now - minutes * 60
        cols = ["air_temp", "air_humidity", "vpd", "co2", "par", "soil_temp",
                "soil_moisture", "soil_ph", "soil_ec", "dli", "vent", "shade"]
        out: dict[str, dict] = {}

        with self._lock:
            zones = [zone] if zone else \
                [r[0] for r in self.conn.execute(
                    "SELECT DISTINCT zone FROM zone_samples WHERE ts >= ?", (since,))]
            for zid in zones:
                rows = self.conn.execute(
                    f"SELECT ts, {','.join(cols)} FROM zone_samples "
                    f"WHERE zone = ? AND ts >= ? ORDER BY ts", (zid, since)).fetchall()
                if not rows:
                    continue
                step = max(1, len(rows) // max_points)
                rows = rows[::step]
                out[zid] = {
                    "t": [round(r[0], 1) for r in rows],
                    **{c: [None if r[i + 1] is None else round(r[i + 1], 2)
                           for r in rows] for i, c in enumerate(cols)},
                }

            wrows = self.conn.execute(
                "SELECT ts, t_out, rh_out, ghi, par, wind, rain, et0 "
                "FROM weather_samples WHERE ts >= ? ORDER BY ts", (since,)).fetchall()
            if wrows:
                step = max(1, len(wrows) // max_points)
                wrows = wrows[::step]
                out["WX"] = {
                    "t": [round(r[0], 1) for r in wrows],
                    "t_out": [round(r[1], 1) for r in wrows],
                    "rh_out": [round(r[2], 1) for r in wrows],
                    "ghi": [round(r[3], 1) for r in wrows],
                    "wind": [round(r[5], 1) for r in wrows],
                    "rain": [round(r[6], 1) for r in wrows],
                }
        return out

    def decisions(self, limit: int = 100) -> list[dict]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT payload FROM decisions ORDER BY ts DESC LIMIT ?",
                (limit,)).fetchall()
        return [json.loads(r[0]) for r in rows]

    def stats(self) -> dict:
        with self._lock:
            n = self.conn.execute("SELECT COUNT(*) FROM zone_samples").fetchone()[0]
            d = self.conn.execute("SELECT COUNT(*) FROM decisions").fetchone()[0]
        return {"zone_samples": n, "decisions": d, "db": self.path}

    def close(self):
        self.flush(force=True)
        self.conn.close()
