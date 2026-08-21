from typing import Any


def normalize_pages(report: dict[str, Any]) -> list[dict[str, Any]]:
    pages = report.get('pages') if isinstance(report.get('pages'), list) else []
    if not pages:
        return [{'id': 'page_1', 'name': 'Página 1', 'order': 0}]
    out = []
    for idx, page in enumerate(pages):
        if not isinstance(page, dict):
            continue
        page_id = str(page.get('id') or f'page_{idx+1}')
        out.append({**page, 'id': page_id, 'name': str(page.get('name') or f'Página {idx+1}'), 'order': page.get('order', idx)})
    return out or [{'id': 'page_1', 'name': 'Página 1', 'order': 0}]


def allowed_page_ids_for_report(user: dict[str, Any], report: dict[str, Any]) -> list[str]:
    pages = normalize_pages(report)
    if not user or user.get('role') == 'admin':
        return [p['id'] for p in pages]
    permissions = user.get('reportPermissions') if isinstance(user.get('reportPermissions'), dict) else {}
    if not permissions:
        return [p['id'] for p in pages]
    perm = permissions.get(str(report.get('id') or ''))
    if not isinstance(perm, dict):
        return []
    if perm.get('allPages'):
        return [p['id'] for p in pages]
    allowed = {str(x) for x in perm.get('pageIds', []) if x}
    return [p['id'] for p in pages if p['id'] in allowed]


def apply_user_access(report: dict[str, Any], user: dict[str, Any]) -> dict[str, Any] | None:
    allowed = set(allowed_page_ids_for_report(user, report))
    if not allowed:
        return None
    clone = dict(report)
    clone['pages'] = [p for p in normalize_pages(report) if p['id'] in allowed]
    clone['visuals'] = [v for v in report.get('visuals', []) if not isinstance(v, dict) or str(v.get('pageId') or 'page_1') in allowed]
    filters = report.get('onlineFilters') if isinstance(report.get('onlineFilters'), list) else []
    clone['onlineFilters'] = [f for f in filters if not isinstance(f, dict) or f.get('scope') != 'page' or str(f.get('pageId') or f.get('target') or '') in allowed]
    return clone


def reports_for_user(reports: list[dict[str, Any]], user: dict[str, Any]) -> list[dict[str, Any]]:
    return [r for r in (apply_user_access(report, user) for report in reports) if r]


def public_report(report: dict[str, Any]) -> dict[str, Any]:
    hidden = {'sql'}
    clone = {k: v for k, v in report.items() if k not in hidden}
    for visual in clone.get('visuals', []) if isinstance(clone.get('visuals'), list) else []:
        if isinstance(visual, dict):
            visual.pop('sql', None)
    return clone
