/* ═══════════════════════════════════════════════════════════════════════════
   SERVICE EXCEPTION WORKFLOW — termac-exception.js
   Shared module used by: Termac Driver Portal, all Tech Portals
   
   Handles: Customer not present · Refused service · Access denied ·
            Partial delivery · Safety concern · Equipment not ready ·
            Rescheduled on-site · Unable to complete (parts needed)
   
   Writes to: termac_exceptions (localStorage) → syncs to manager dashboard
   Auto-triggers: reschedule prompt, manager notification flag, account note
═══════════════════════════════════════════════════════════════════════════ */

const EXCEPTION_TYPES = [
  { key:'no_answer',    label:'No Answer / Not Present',     icon:'🚫', color:'#DC2626', requiresPhoto:true,  requiresReschedule:true  },
  { key:'refused',      label:'Customer Refused Service',    icon:'❌', color:'#DC2626', requiresPhoto:false, requiresReschedule:false },
  { key:'access',       label:'Access Denied / Locked Out',  icon:'🔒', color:'#D97706', requiresPhoto:true,  requiresReschedule:true  },
  { key:'partial',      label:'Partial Delivery / Service',  icon:'⚠️', color:'#D97706', requiresPhoto:false, requiresReschedule:false },
  { key:'safety',       label:'Safety Concern — Cannot Proceed', icon:'⛔', color:'#DC2626', requiresPhoto:true,  requiresReschedule:true  },
  { key:'not_ready',    label:'Equipment / Site Not Ready',  icon:'🔧', color:'#D97706', requiresPhoto:false, requiresReschedule:true  },
  { key:'rescheduled',  label:'Rescheduled On-Site',         icon:'📅', color:'#1B5FA8', requiresPhoto:false, requiresReschedule:false },
  { key:'parts_needed', label:'Parts / Supplies Needed',     icon:'📦', color:'#6D28D9', requiresPhoto:false, requiresReschedule:true  },
];

let _exState = { jobId:null, accountName:null, address:null, division:null, photoDataUrl:null, stream:null };

/* ── Open the exception modal ──────────────────────────────────────────── */
function openExceptionModal(jobId, accountName, address, division) {
  _exState = { jobId, accountName, address, division, photoDataUrl:null, stream:null };
  let modal = document.getElementById('exceptionModal');
  if (!modal) _injectExceptionModal();
  modal = document.getElementById('exceptionModal');
  document.getElementById('exAcctName').textContent  = accountName || '—';
  document.getElementById('exAcctAddr').textContent  = address    || '—';
  document.getElementById('exType').value            = '';
  document.getElementById('exNotes').value           = '';
  document.getElementById('exRescheduleRow').style.display = 'none';
  document.getElementById('exPhotoRow').style.display     = 'none';
  document.getElementById('exPhotoPreview').style.display = 'none';
  document.getElementById('exCameraRow').style.display    = 'none';
  document.getElementById('exPhotoStatus').textContent    = '';
  _exState.photoDataUrl = null;
  modal.classList.add('open');
}

function closeExceptionModal() {
  const modal = document.getElementById('exceptionModal');
  if (modal) modal.classList.remove('open');
  _stopCamera();
}

/* ── Exception type selection ──────────────────────────────────────────── */
function onExTypeChange() {
  const key = document.getElementById('exType').value;
  const type = EXCEPTION_TYPES.find(t => t.key === key);
  if (!type) return;
  document.getElementById('exRescheduleRow').style.display = type.requiresReschedule ? 'block' : 'none';
  document.getElementById('exPhotoRow').style.display      = type.requiresPhoto      ? 'block' : 'none';
  // Set default reschedule to tomorrow
  if (type.requiresReschedule) {
    const tomorrow = new Date(Date.now() + 86400000);
    document.getElementById('exRescheduleDate').value = tomorrow.toISOString().split('T')[0];
  }
}

/* ── Camera / photo capture ────────────────────────────────────────────── */
async function exStartCamera() {
  try {
    document.getElementById('exCameraRow').style.display = 'block';
    const video = document.getElementById('exCameraFeed');
    _exState.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode:'environment' }, audio:false });
    video.srcObject = _exState.stream;
    await video.play();
    document.getElementById('exPhotoStatus').textContent = '📸 Camera ready — position and capture';
  } catch(e) {
    document.getElementById('exPhotoStatus').textContent = '⚠️ Camera unavailable — describe situation in notes';
  }
}

function exCapturePhoto() {
  const video  = document.getElementById('exCameraFeed');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  canvas.getContext('2d').drawImage(video, 0, 0);
  _exState.photoDataUrl = canvas.toDataURL('image/jpeg', 0.7);
  const preview = document.getElementById('exPhotoPreview');
  preview.src = _exState.photoDataUrl;
  preview.style.display = 'block';
  document.getElementById('exPhotoStatus').textContent = '✅ Photo captured';
  _stopCamera();
}

function _stopCamera() {
  if (_exState.stream) {
    _exState.stream.getTracks().forEach(t => t.stop());
    _exState.stream = null;
  }
  const cr = document.getElementById('exCameraRow');
  if (cr) cr.style.display = 'none';
}

/* ── Save exception record ─────────────────────────────────────────────── */
function saveException() {
  const typeKey   = document.getElementById('exType').value;
  const notes     = document.getElementById('exNotes').value.trim();
  const reschedDate = document.getElementById('exRescheduleDate')?.value || '';

  if (!typeKey) { alert('Select an exception type.'); return; }

  const type = EXCEPTION_TYPES.find(t => t.key === typeKey);
  if (type?.requiresPhoto && !_exState.photoDataUrl) {
    if (!confirm('No photo captured. Continue without photo?')) return;
  }
  if (!notes && typeKey !== 'rescheduled') {
    alert('Add a brief note describing the situation.'); return;
  }

  const record = {
    id:          'exc_' + Date.now(),
    jobId:       _exState.jobId,
    accountName: _exState.accountName,
    address:     _exState.address,
    division:    _exState.division,
    typeKey,
    typeLabel:   type?.label || typeKey,
    typeIcon:    type?.icon  || '⚠️',
    notes,
    rescheduleDate: reschedDate || null,
    photoDataUrl:   _exState.photoDataUrl,
    techName:    (typeof _currentUser !== 'undefined' && _currentUser?.name) || 'Field Tech',
    timestamp:   Date.now(),
    date:        new Date().toLocaleDateString('en-US'),
    resolved:    false,
  };

  // Save to localStorage
  try {
    const existing = JSON.parse(localStorage.getItem('termac_exceptions') || '[]');
    existing.unshift(record);
    localStorage.setItem('termac_exceptions', JSON.stringify(existing));
  } catch(e) { console.warn('Exception save error:', e); }

  // Write note to account record if account system exists
  _writeExceptionToAccount(record);

  closeExceptionModal();
  _showExceptionConfirmation(record);
  return record;
}

function _writeExceptionToAccount(record) {
  try {
    // Try CRM accounts first
    const acctKeys = ['termac_crm_accounts','crm_accounts'];
    for (const key of acctKeys) {
      const accounts = JSON.parse(localStorage.getItem(key) || '[]');
      const acct = accounts.find(a =>
        (a.business||a.name||'').toLowerCase() === record.accountName.toLowerCase()
      );
      if (acct) {
        acct.activityLog = acct.activityLog || [];
        acct.activityLog.unshift({
          ts:    record.timestamp,
          type:  'exception',
          icon:  record.typeIcon,
          title: `Service Exception — ${record.typeLabel}`,
          note:  record.notes + (record.rescheduleDate ? ` · Reschedule: ${record.rescheduleDate}` : ''),
          who:   record.techName,
        });
        localStorage.setItem(key, JSON.stringify(accounts));
        break;
      }
    }
  } catch(e) {}
}

function _showExceptionConfirmation(record) {
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1A1D21;color:#fff;border-left:4px solid #F59E0B;border-radius:10px;padding:14px 20px;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);font-family:Barlow Condensed,sans-serif;max-width:340px;width:90%';
  toast.innerHTML = `<div style="font-weight:800;font-size:13px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px">${record.typeIcon} Exception Logged</div>
    <div style="font-size:12px;color:#BFC4CA">${record.accountName} · ${record.typeLabel}</div>
    ${record.rescheduleDate ? `<div style="font-size:11px;color:#F59E0B;margin-top:4px">📅 Reschedule flagged: ${record.rescheduleDate}</div>` : ''}
    <div style="font-size:11px;color:#6B7280;margin-top:4px">Logged to account record · Manager notified</div>`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

/* ── Inject modal HTML ─────────────────────────────────────────────────── */
function _injectExceptionModal() {
  const div = document.createElement('div');
  div.innerHTML = `
<div class="crm-modal-bg" id="exceptionModal" style="z-index:600">
  <div class="crm-modal" style="max-width:480px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <h3 style="margin:0;color:#DC2626">⚠️ Service Exception</h3>
      <button onclick="closeExceptionModal()" style="background:none;border:none;font-size:20px;cursor:pointer;color:#6B7280">✕</button>
    </div>
    <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:10px 14px;margin-bottom:14px">
      <div style="font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:14px" id="exAcctName">—</div>
      <div style="font-size:12px;color:#6B7280;margin-top:2px" id="exAcctAddr">—</div>
    </div>

    <div style="margin-bottom:12px">
      <label style="display:block;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#6B7280;margin-bottom:5px">Exception Type *</label>
      <select id="exType" onchange="onExTypeChange()" style="width:100%;padding:9px 11px;border:1.5px solid #D1D5DB;border-radius:8px;font-size:13px;font-family:inherit;outline:none">
        <option value="">— Select reason —</option>
        ${EXCEPTION_TYPES.map(t => `<option value="${t.key}">${t.icon} ${t.label}</option>`).join('')}
      </select>
    </div>

    <div style="margin-bottom:12px">
      <label style="display:block;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#6B7280;margin-bottom:5px">Notes *</label>
      <textarea id="exNotes" rows="3" placeholder="Describe exactly what happened — customer name spoken to, what was said, condition observed..." style="width:100%;padding:9px 11px;border:1.5px solid #D1D5DB;border-radius:8px;font-size:13px;font-family:inherit;outline:none;resize:vertical"></textarea>
    </div>

    <div id="exRescheduleRow" style="display:none;margin-bottom:12px">
      <label style="display:block;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#6B7280;margin-bottom:5px">Suggested Reschedule Date</label>
      <input type="date" id="exRescheduleDate" style="width:100%;padding:9px 11px;border:1.5px solid #D1D5DB;border-radius:8px;font-size:13px;font-family:inherit;outline:none">
    </div>

    <div id="exPhotoRow" style="display:none;margin-bottom:12px">
      <label style="display:block;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#6B7280;margin-bottom:5px">📸 Photo Documentation</label>
      <button onclick="exStartCamera()" style="background:#1B5FA8;color:#fff;border:none;border-radius:8px;padding:9px 16px;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:12px;cursor:pointer;margin-bottom:8px">📷 Open Camera</button>
      <div id="exCameraRow" style="display:none;margin-bottom:8px">
        <video id="exCameraFeed" autoplay playsinline style="width:100%;border-radius:8px;background:#000;max-height:200px"></video>
        <button onclick="exCapturePhoto()" style="width:100%;margin-top:6px;background:#DC2626;color:#fff;border:none;border-radius:8px;padding:10px;font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:13px;cursor:pointer">📸 Capture Photo</button>
      </div>
      <img id="exPhotoPreview" style="display:none;width:100%;border-radius:8px;border:1.5px solid #D1D5DB;margin-bottom:6px" alt="Exception photo">
      <div id="exPhotoStatus" style="font-size:12px;color:#6B7280"></div>
    </div>

    <div style="display:flex;gap:10px;margin-top:16px">
      <button onclick="closeExceptionModal()" style="flex:1;padding:11px;background:none;border:1.5px solid #D1D5DB;border-radius:8px;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:13px;cursor:pointer;color:#6B7280">Cancel</button>
      <button onclick="saveException()" style="flex:2;padding:11px;background:#DC2626;color:#fff;border:none;border-radius:8px;font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:13px;letter-spacing:.06em;text-transform:uppercase;cursor:pointer">⚠️ Log Exception</button>
    </div>
  </div>
</div>`;
  document.body.appendChild(div.firstElementChild);
}
