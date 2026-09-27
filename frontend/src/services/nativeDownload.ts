import { api } from './api';

// Native attachment downloads avoid buffering multi-GB files in the SPA.
// Each attempt needs a fresh, session-bound, single-use ticket.
export async function savePreparedFile(jobId: string, isCancelled = () => false): Promise<boolean> {
  const ticket = await api.getDownloadTicket(jobId);
  if (isCancelled()) return false;
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = `/api/downloads/${encodeURIComponent(jobId)}/file`;
  const input = document.createElement('input');
  input.type = 'hidden'; input.name = 'ticket'; input.value = ticket;
  form.appendChild(input);
  document.body.appendChild(form);
  try { form.submit(); } finally { form.remove(); }
  return true;
}
