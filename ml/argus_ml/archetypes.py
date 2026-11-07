"""Injury archetypes for synthetic casualties.

Every range here is an ILLUSTRATIVE PLACEHOLDER chosen to make a believable
demo, not clinical evidence. The UI and pitch label them as such.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Need:
    resource: str  # blood_unit | o2 | vent | or_table
    amount: tuple[float, float]  # uniform range
    probability: float  # chance this patient needs it at all
    offset_min: tuple[float, float]  # minutes after arrival it starts
    duration_min: tuple[float, float]  # 0 = held until evacuation


@dataclass(frozen=True)
class Archetype:
    key: str
    label: str
    mechanism: str
    hr: tuple[float, float]
    sbp: tuple[float, float]
    rr: tuple[float, float]
    spo2: tuple[float, float]
    gcs: tuple[int, int]
    walks_probability: float
    hemorrhage_uncontrolled_probability: float
    minor_only: bool
    # Vitals drift per 30 simulated minutes without definitive care.
    drift_per_30: dict[str, float] = field(default_factory=dict)
    needs: tuple[Need, ...] = ()
    narrative: tuple[str, ...] = ()


ARCHETYPES: dict[str, Archetype] = {
    a.key: a
    for a in [
        Archetype(
            key="penetrating_torso",
            label="Penetrating torso",
            mechanism="Penetrating — falling steel / debris",
            hr=(118, 145), sbp=(72, 96), rr=(24, 34), spo2=(88, 95), gcs=(12, 15),
            walks_probability=0.0, hemorrhage_uncontrolled_probability=0.5, minor_only=False,
            drift_per_30={"hr": 8, "sbp": -9, "rr": 3, "spo2": -2, "gcs": -1},
            needs=(
                Need("blood_unit", (4, 8), 1.0, (2, 8), (70, 110)),
                Need("or_table", (1, 1), 0.85, (10, 30), (70, 110)),
                Need("o2", (1, 2), 0.7, (0, 5), (60, 120)),
                Need("vent", (1, 1), 0.15, (20, 40), (0, 0)),
            ),
            narrative=(
                "impaled by rebar to the left flank",
                "penetrating abdominal wound from falling steel",
                "shrapnel wound right chest, decreased breath sounds",
            ),
        ),
        Archetype(
            key="blast_extremity",
            label="Blast extremity",
            mechanism="Blast — structural collapse",
            hr=(105, 135), sbp=(84, 110), rr=(20, 30), spo2=(92, 97), gcs=(13, 15),
            walks_probability=0.0, hemorrhage_uncontrolled_probability=0.3, minor_only=False,
            drift_per_30={"hr": 5, "sbp": -5, "rr": 1, "spo2": -1},
            needs=(
                Need("blood_unit", (2, 4), 0.9, (3, 10), (60, 90)),
                Need("or_table", (1, 1), 0.6, (20, 45), (60, 90)),
                Need("o2", (0.5, 1), 0.4, (0, 10), (60, 120)),
            ),
            narrative=(
                "partial amputation left lower leg, tourniquet applied",
                "open tib/fib fracture with heavy bleeding",
                "mangled right forearm, tourniquet on",
            ),
        ),
        Archetype(
            key="crush",
            label="Crush injury",
            mechanism="Crush — trapped under concrete",
            hr=(98, 125), sbp=(88, 115), rr=(18, 28), spo2=(93, 98), gcs=(13, 15),
            walks_probability=0.0, hemorrhage_uncontrolled_probability=0.05, minor_only=False,
            drift_per_30={"hr": 4, "sbp": -4, "rr": 1},
            needs=(
                Need("blood_unit", (1, 2), 0.5, (10, 30), (60, 90)),
                Need("o2", (0.5, 1), 0.5, (0, 10), (60, 120)),
            ),
            narrative=(
                "trapped 40 minutes under a concrete slab, both legs",
                "pelvis pinned by fallen beam, extricated",
            ),
        ),
        Archetype(
            key="head_injury",
            label="Head injury",
            mechanism="Blunt — struck by debris",
            hr=(60, 95), sbp=(120, 165), rr=(10, 22), spo2=(90, 97), gcs=(7, 13),
            walks_probability=0.0, hemorrhage_uncontrolled_probability=0.0, minor_only=False,
            drift_per_30={"gcs": -1.2, "rr": -2, "spo2": -1.5},
            needs=(
                Need("o2", (1, 2), 0.9, (0, 5), (90, 150)),
                Need("vent", (1, 1), 0.6, (10, 40), (0, 0)),
            ),
            narrative=(
                "struck on head by falling light rig, unequal pupils",
                "found unresponsive under seating, scalp laceration",
            ),
        ),
        Archetype(
            key="burns",
            label="Burns",
            mechanism="Thermal — electrical fire",
            hr=(100, 130), sbp=(95, 125), rr=(20, 30), spo2=(90, 96), gcs=(13, 15),
            walks_probability=0.15, hemorrhage_uncontrolled_probability=0.0, minor_only=False,
            drift_per_30={"hr": 3, "sbp": -3, "spo2": -1},
            needs=(
                Need("o2", (1, 2), 0.8, (0, 5), (90, 150)),
                Need("vent", (1, 1), 0.1, (20, 50), (0, 0)),
            ),
            narrative=(
                "partial-thickness burns ~20% TBSA arms and torso",
                "flash burns to face and hands, singed nasal hair",
            ),
        ),
        Archetype(
            key="inhalation",
            label="Smoke inhalation",
            mechanism="Inhalation — smoke and dust",
            hr=(95, 120), sbp=(110, 135), rr=(22, 32), spo2=(86, 94), gcs=(14, 15),
            walks_probability=0.4, hemorrhage_uncontrolled_probability=0.0, minor_only=False,
            drift_per_30={"spo2": -1, "rr": 1},
            needs=(Need("o2", (0.5, 1.5), 0.9, (0, 5), (60, 120)),),
            narrative=("coughing, hoarse voice after dust and smoke exposure",),
        ),
        Archetype(
            key="fracture",
            label="Closed fracture",
            mechanism="Fall — crowd crush on stairs",
            hr=(85, 110), sbp=(115, 140), rr=(16, 22), spo2=(96, 99), gcs=(15, 15),
            walks_probability=0.35, hemorrhage_uncontrolled_probability=0.0, minor_only=False,
            needs=(),
            narrative=("closed fracture right wrist", "suspected closed femur fracture, splinted"),
        ),
        Archetype(
            key="minor_laceration",
            label="Minor laceration",
            mechanism="Blunt — crowd surge",
            hr=(75, 100), sbp=(118, 140), rr=(14, 20), spo2=(97, 100), gcs=(15, 15),
            walks_probability=0.95, hemorrhage_uncontrolled_probability=0.0, minor_only=True,
            needs=(),
            narrative=("superficial forearm laceration", "abrasions and bruising, ambulatory"),
        ),
    ]
}
