import React, { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Header } from '../components/Header';
import { Sidebar } from '../components/Sidebar';
import { api } from '../services/api';
import { DownloadPolicy, DownloadQuality, Library, PermissionUser } from '../types';
import { useMobileMenu } from '../hooks/useMobileMenu';
import { useAuthStore } from '../stores/authStore';

const labels: Record<DownloadQuality, string> = { original: 'Original file', '720p-2': '720p · 2 Mbps', '720p-4': '720p · 4 Mbps', '1080p-8': '1080p · 8 Mbps' };
const PolicyEditor: React.FC<{ id: string; title: string; policy: DownloadPolicy; libraries: Library[]; custom?: boolean; onSaved: () => Promise<void> }> = props => {
  const [policy, setPolicy] = useState(props.policy);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { setPolicy(props.policy); }, [props.policy]);
  const save = async (inherit = false) => {
    setSaving(true); setMessage('');
    try {
      await api.saveDownloadPolicy(props.id, inherit ? { inherit: true } : policy);
      await props.onSaved(); setMessage('Saved.');
    } catch (err: any) { setMessage(err.response?.data?.error || 'Could not save permissions.'); }
    finally { setSaving(false); }
  };
  return <section className="card p-5 space-y-4">
    <div><h2 className="text-xl font-semibold">{props.title}</h2>{props.id !== 'default' && <p className="text-sm text-gray-400">{props.custom ? 'Individual permissions' : 'Uses default permissions'}</p>}</div>
    <label className="flex gap-3 items-center"><input type="checkbox" checked={policy.enabled} onChange={event => setPolicy({ ...policy, enabled: event.target.checked })} />Allow downloads</label>
    <fieldset disabled={!policy.enabled || saving} className="space-y-3 disabled:opacity-50">
      <legend className="font-medium mb-2">Libraries available for download</legend>
      <label className="flex gap-3 items-center"><input type="checkbox" checked={policy.libraries === null} onChange={event => setPolicy({ ...policy, libraries: event.target.checked ? null : [] })} />All libraries shared with this account in Plex</label>
      {policy.libraries !== null && <div className="flex flex-wrap gap-x-6 gap-y-2">{props.libraries.map(library => <label key={library.key} className="flex gap-2 items-center"><input type="checkbox" checked={policy.libraries!.includes(String(library.key))} onChange={event => setPolicy({ ...policy, libraries: event.target.checked ? [...policy.libraries!, String(library.key)] : policy.libraries!.filter(id => id !== String(library.key)) })} />{library.title}</label>)}</div>}
      <p className="font-medium pt-2">Allowed qualities</p>
      <div className="flex flex-wrap gap-x-6 gap-y-2">{(Object.keys(labels) as DownloadQuality[]).map(quality => <label key={quality} className="flex gap-2 items-center"><input type="checkbox" checked={policy.qualities.includes(quality)} onChange={event => setPolicy({ ...policy, qualities: event.target.checked ? [...policy.qualities, quality] : policy.qualities.filter(item => item !== quality) })} />{labels[quality]}</label>)}</div>
      <p className="text-sm text-gray-400">Disable Original file to require conversion for video. Audio downloads require Original file.</p>
    </fieldset>
    <div className="flex flex-wrap gap-3 items-center"><button className="btn-primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save permissions'}</button>{props.custom && <button className="btn-secondary" disabled={saving} onClick={() => void save(true)}>Use defaults</button>}<span role="status" className="text-sm">{message}</span></div>
  </section>;
};

export const Permissions: React.FC = () => {
  const { user } = useAuthStore();
  const { isMobileMenuOpen, toggleMobileMenu, closeMobileMenu } = useMobileMenu();
  const [data, setData] = useState<{ defaultPolicy: DownloadPolicy; users: PermissionUser[] } | null>(null);
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [error, setError] = useState('');
  const load = async () => {
    const [permissions, available] = await Promise.all([api.getPermissions(), api.getLibraries()]);
    setData(permissions); setLibraries(available);
  };
  useEffect(() => { if (user?.isAdmin) void load().catch((err: any) => setError(err.response?.data?.error || 'Could not load permissions. Connect Plex in Settings first.')); }, [user?.isAdmin]);
  if (!user?.isAdmin) return <Navigate to="/" replace />;
  return <div className="min-h-screen flex flex-col"><Header onMenuClick={toggleMobileMenu} /><div className="flex flex-1 overflow-hidden"><Sidebar isOpen={isMobileMenuOpen} onClose={closeMobileMenu} /><main className="flex-1 p-4 md:p-8 overflow-y-auto"><div className="max-w-4xl space-y-5">
    <h1 className="text-3xl font-bold">Download permissions</h1>
    <p className="text-gray-400">These rules restrict downloads through LibraryDownloadarr. Library visibility and Plex sharing remain managed in Plex. These rules cannot grant access or download rights that Plex denies.</p>
    <p className="text-sm text-gray-400">Defaults apply to new users and users without individual rules. Individual rules replace the defaults. Changes are checked before a prepared file is delivered; transfers already in progress are not interrupted.</p>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    {!data && !error && <p>Loading…</p>}
    {data && <><PolicyEditor id="default" title="Default permissions" policy={data.defaultPolicy} libraries={libraries} onSaved={load} />
      {!data.users.length && <p className="text-gray-400">Friends appear here after their first Plex sign-in. Existing users must sign in again after this update.</p>}
      {data.users.map(user => <PolicyEditor key={user.id} id={user.id} title={user.username} policy={user.policy} custom={user.custom} libraries={libraries} onSaved={load} />)}</>}
  </div></main></div></div>;
};
