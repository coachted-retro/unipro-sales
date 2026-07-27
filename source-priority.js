// SHARED SOURCE PRIORITY ENGINE
// Call spSourcePriority(source) anywhere to get tag, color, bg, priority.
// This is the single source of truth for how every lead source is
// classified and displayed across every portal and notification panel.

function spSourcePriority(source) {
  var s = String(source || '').toLowerCase();

  if (s.indexOf('reception') !== -1 || s.indexOf('receptionist') !== -1)
    return { tag:'RECEPTION', icon:'📞', priority:1, color:'#991B1B', bg:'#FEE2E2', border:'#C8102E' };

  if (s.indexOf('dms') !== -1 || s.indexOf('digital') !== -1)
    return { tag:'DMS', icon:'💬', priority:1, color:'#991B1B', bg:'#FEE2E2', border:'#C8102E' };

  if (s.indexOf('manager') !== -1 || s.indexOf('jim') !== -1 || s.indexOf('escalat') !== -1)
    return { tag:'MANAGER', icon:'⚠️', priority:2, color:'#92400E', bg:'#FFFBEB', border:'#D97706' };

  if (s.indexOf('harvest') !== -1 || s.indexOf('scrape') !== -1 || s.indexOf('violation') !== -1 || s.indexOf('fire') !== -1 || s.indexOf('safety') !== -1 || s.indexOf('inspection') !== -1)
    return { tag:'WARM LEAD', icon:'🌡️', priority:3, color:'#1E40AF', bg:'#EFF6FF', border:'#3B82F6' };

  if (s.indexOf('referral') !== -1)
    return { tag:'REFERRAL', icon:'🤝', priority:2, color:'#166534', bg:'#F0FDF4', border:'#16A34A' };

  if (s.indexOf('web') !== -1 || s.indexOf('online') !== -1 || s.indexOf('servicetrade') !== -1)
    return { tag:'INBOUND', icon:'🌐', priority:3, color:'#374151', bg:'#F9FAFB', border:'#9CA3AF' };

  return { tag:'LEAD', icon:'🎯', priority:3, color:'#374151', bg:'#F9FAFB', border:'#9CA3AF' };
}

function spSourceBadgeHtml(source) {
  var p = spSourcePriority(source);
  return '<span style="background:' + p.bg + ';color:' + p.color + ';border:1px solid ' + p.border + ';border-radius:4px;padding:1px 7px;font-size:9px;font-weight:800;font-family:Barlow Condensed,sans-serif;letter-spacing:.06em;white-space:nowrap">'
    + p.icon + ' ' + p.tag + '</span>';
}
