"""어댑터 registry. 신규 소스 추가 시 이 dict 에만 기입하면 runner 가 인식."""

from __future__ import annotations

from app.services.announcements.adapters.bizinfo import BizInfoAdapter
from app.services.announcements.adapters.g2b import G2BAdapter
from app.services.announcements.adapters.iitp import IitpAdapter
from app.services.announcements.adapters.iris import IrisAdapter
from app.services.announcements.adapters.keit import KeitAdapter
from app.services.announcements.adapters.kstartup import KStartupAdapter
from app.services.announcements.adapters.nia import NiaAdapter
from app.services.announcements.adapters.nipa import NipaAdapter
from app.services.announcements.adapters.ntis import NtisAdapter
from app.services.announcements.base import AnnouncementAdapter

ADAPTERS: dict[str, type[AnnouncementAdapter]] = {
    G2BAdapter.code: G2BAdapter,
    NtisAdapter.code: NtisAdapter,
    BizInfoAdapter.code: BizInfoAdapter,
    KStartupAdapter.code: KStartupAdapter,
    IrisAdapter.code: IrisAdapter,
    NipaAdapter.code: NipaAdapter,
    IitpAdapter.code: IitpAdapter,
    KeitAdapter.code: KeitAdapter,
    NiaAdapter.code: NiaAdapter,
}
