# -*- coding: utf-8 -*-
"""
传感器数据源抽象层
==================

设计目标
--------
1. **协议无关**：无论数据来自模拟器、Modbus 网关、MQTT 主题还是 HTTP 接口，
   上层（孪生引擎 / 决策 Agent / 前端）都只看到统一的 ``readings`` 结构。
2. **零改动接入真实硬件**：把 ``config.SENSOR_NODES`` 中某个节点的
   ``protocol`` 字段从 ``"simulated"`` 改成 ``"modbus"`` / ``"mqtt"`` / ``"http"``，
   并在 ``registry.py`` 中注册对应适配器即可，业务代码一行不改。

统一数据结构
------------
``Reading``      —— 单个测点的一次读数
``NodeReadings`` —— 一个节点（一台采集器 / 一套传感器）在同一时刻的全部读数

一次完整读数的字段：
    node_id, zone, kind, ts(epoch 秒), values{metric: value}, quality, online
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------

@dataclass
class Reading:
    """单个测点读数。"""
    metric: str                 # 指标键，见 config.METRICS
    value: float                # 数值
    unit: str = ""
    quality: str = "good"       # good / suspect / bad / offline
    ts: float = field(default_factory=time.time)


@dataclass
class NodeReadings:
    """一台采集节点在一个时刻的全部读数。"""
    node_id: str
    zone: str
    kind: str                   # greenhouse / weather / water
    ts: float
    values: dict[str, float] = field(default_factory=dict)
    quality: str = "good"
    online: bool = True
    # 溯源信息：便于排查"这个数到底哪来的"
    source: str = "simulator"

    def get(self, metric: str, default: float | None = None) -> float | None:
        return self.values.get(metric, default)

    def to_dict(self) -> dict:
        return {
            "node_id": self.node_id,
            "zone": self.zone,
            "kind": self.kind,
            "ts": round(self.ts, 3),
            "values": {k: round(v, 3) for k, v in self.values.items()},
            "quality": self.quality,
            "online": self.online,
            "source": self.source,
        }


# ---------------------------------------------------------------------------
# 数据源协议
# ---------------------------------------------------------------------------

@runtime_checkable
class SensorSource(Protocol):
    """
    任何传感器数据源都必须实现这三个方法。

    ``describe()``  返回节点静态信息（给 UI 展示点位、量程、协议）
    ``read()``      返回该节点当前时刻的读数
    ``healthy()``   数据源是否可用（用于在线率统计与告警）
    """

    node_id: str

    def describe(self) -> dict: ...

    def read(self) -> NodeReadings: ...

    def healthy(self) -> bool: ...


# ---------------------------------------------------------------------------
# 基类（提供通用实现，真实适配器继承即可）
# ---------------------------------------------------------------------------

class BaseSensorSource:
    """
    适配器基类。

    子类通常只需要实现 ``_acquire()``：把硬件原始值取回来并填进 values 字典。
    量程校验、单位补齐、异常降级都在这里统一处理，避免每个适配器重复写一遍。
    """

    node_id: str = ""
    kind: str = "greenhouse"
    zone: str = ""
    protocol: str = "generic"

    def __init__(self, node_cfg: dict, metric_defs: dict):
        self.node = node_cfg
        self.node_id = node_cfg["id"]
        self.zone = node_cfg.get("zone", "")
        self.kind = node_cfg.get("kind", "greenhouse")
        self.metrics: list[str] = list(node_cfg.get("metrics", []))
        self.metric_defs = metric_defs
        self._last: NodeReadings | None = None

    # -- 子类实现 ---------------------------------------------------------
    def _acquire(self) -> dict[str, float]:
        raise NotImplementedError

    def _connected(self) -> bool:
        return True

    # -- 对外接口 ---------------------------------------------------------
    def describe(self) -> dict:
        return {
            "id": self.node_id,
            "name": self.node.get("name", self.node_id),
            "zone": self.zone,
            "kind": self.kind,
            "protocol": self.protocol,
            "pos": list(self.node.get("pos", (0, 0, 0))),
            "metrics": [
                {
                    "key": m,
                    "label": self.metric_defs.get(m, {}).get("label", m),
                    "unit": self.metric_defs.get(m, {}).get("unit", ""),
                }
                for m in self.metrics
            ],
        }

    def read(self) -> NodeReadings:
        ts = time.time()
        if not self._connected():
            out = NodeReadings(self.node_id, self.zone, self.kind, ts,
                               online=False, quality="offline", source=self.protocol)
            self._last = out
            return out

        try:
            raw = self._acquire()
        except Exception:
            # 硬件通信失败：不抛异常打断孪生循环，降级为离线帧
            out = NodeReadings(self.node_id, self.zone, self.kind, ts,
                               online=False, quality="offline", source=self.protocol)
            self._last = out
            return out

        values: dict[str, float] = {}
        quality = "good"
        for m in self.metrics:
            if m not in raw:
                continue
            v = float(raw[m])
            rng = self.metric_defs.get(m, {}).get("range")
            # 量程校验：超量程标记 suspect，但数值照常上报（便于发现传感器故障）
            if rng and not (rng[0] <= v <= rng[1]):
                quality = "suspect"
                v = min(max(v, rng[0]), rng[1])
            values[m] = v

        out = NodeReadings(self.node_id, self.zone, self.kind, ts, values,
                           quality=quality, online=True, source=self.protocol)
        self._last = out
        return out

    def healthy(self) -> bool:
        return self._connected()
