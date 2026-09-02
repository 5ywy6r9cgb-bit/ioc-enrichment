"""
tsr_bus/client.py — Import this from BOTH OpenMontage and Sentinel
Research Desk codebases. This is the only thing either system needs
to know about the other: talk to the bus, never to each other's files.

Example (Research Desk side, after sealing a finding):
    from tsr_bus.client import TSRBusClient
    from tsr_bus.schema import SentinelRecord, GlassMarkTier, RecordStatus

    bus = TSRBusClient()
    bus.publish(SentinelRecord(
        record_id="TSR-FLOCK-2026-014",
        case="TSR-FLOCK-COLUMBUS-DELIVERY",
        headline="CPD searched national Flock network 40x for out-of-state plates, Oct 2025",
        summary="...",
        glass_mark_tier=GlassMarkTier.GREEN,
        source_manifest_fingerprint="7584b7fc...",
        origin_system="research_desk",
    ))
    bus.advance("TSR-FLOCK-2026-014", RecordStatus.SEALED)

Example (OpenMontage side, polling for work):
    from tsr_bus.client import TSRBusClient
    from tsr_bus.schema import RecordStatus

    bus = TSRBusClient()
    for record in bus.list(status=RecordStatus.READY_FOR_BROADCAST):
        build_segment(record)
        bus.advance(record.record_id, RecordStatus.IN_PRODUCTION)
"""

from __future__ import annotations
import httpx
from typing import Optional
from schema import SentinelRecord, RecordStatus


class TSRBusClient:
    def __init__(self, base_url: str = "http://127.0.0.1:8420"):
        self.base_url = base_url.rstrip("/")

    def publish(self, record: SentinelRecord) -> SentinelRecord:
        r = httpx.post(f"{self.base_url}/records", json=record.model_dump(mode="json"))
        r.raise_for_status()
        return SentinelRecord(**r.json())

    def get(self, record_id: str) -> SentinelRecord:
        r = httpx.get(f"{self.base_url}/records/{record_id}")
        r.raise_for_status()
        return SentinelRecord(**r.json())

    def list(
        self,
        case: Optional[str] = None,
        status: Optional[RecordStatus] = None,
        origin_system: Optional[str] = None,
    ) -> list[SentinelRecord]:
        params = {}
        if case:
            params["case"] = case
        if status:
            params["status"] = status.value if hasattr(status, "value") else status
        if origin_system:
            params["origin_system"] = origin_system
        r = httpx.get(f"{self.base_url}/records", params=params)
        r.raise_for_status()
        return [SentinelRecord(**rec) for rec in r.json()]

    def advance(self, record_id: str, new_status: RecordStatus) -> SentinelRecord:
        r = httpx.post(
            f"{self.base_url}/records/{record_id}/advance",
            params={"new_status": new_status.value if hasattr(new_status, "value") else new_status},
        )
        r.raise_for_status()
        return SentinelRecord(**r.json())

    def health(self) -> dict:
        r = httpx.get(f"{self.base_url}/health")
        r.raise_for_status()
        return r.json()
