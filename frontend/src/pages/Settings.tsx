import React, { useEffect, useState, useRef } from 'react';
import { Header } from '../components/Header';
import { Sidebar } from '../components/Sidebar';
import { api } from '../services/api';
import { Settings as SettingsType, PlexServerChoice } from '../types';
import { useMobileMenu } from '../hooks/useMobileMenu';

export const Settings: React.FC = () => {
  const { isMobileMenuOpen, toggleMobileMenu, closeMobileMenu } = useMobileMenu();
  const [settings, setSettings] = useState<SettingsType>({
    plexUrl: '',
    hasPlexToken: false,
  });
  const [flowId, setFlowId] = useState('');
  const [servers, setServers] = useState<PlexServerChoice[]>([]);
  const [serverId, setServerId] = useState('');
  const [connecting, setConnecting] = useState(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [plexUrl, setPlexUrl] = useState('');
  const [plexToken, setPlexToken] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Password change state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const data = await api.getSettings();
      setSettings(data);
      setPlexUrl(data.plexUrl);
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to load settings' });
    } finally {
      setIsLoading(false);
    }
  };

  const connectOwner = async () => {
    const popup = window.open('about:blank', '_blank', 'width=600,height=700');
    if (!popup) { setMessage({ type: 'error', text: 'Allow popups, then connect with Plex again.' }); return; }
    setConnecting(true); setServers([]); setFlowId(''); setMessage(null);
    try {
      const pin = await api.connectPlexOwner();
      popup.location.href = pin.url;
      const deadline = Date.now() + 5 * 60 * 1000;
      while (active.current && Date.now() < deadline) {
        const choices = await api.getPlexOwnerServers(pin.flowId);
        if (!active.current) return;
        if (choices) {
          try { popup.close(); } catch { /* Closing an isolated Plex tab is best-effort. */ }
          if (!choices.length) throw new Error('No owned server found. Sign in with the Plex server owner account.');
          setFlowId(pin.flowId); setServers(choices); setServerId(choices[0].id);
          setPlexUrl((choices[0].connections.find(item => item.local) || choices[0].connections[0])?.url || '');
          return;
        }
        // COOP isolation can report an open Plex tab as closed. Only the
        // backend authorization result (or expiry) determines sign-in status.
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      if (active.current) throw new Error('Plex sign-in expired. Please try again.');
    } catch (err: any) {
      if (active.current) setMessage({ type: 'error', text: err.response?.data?.error || err.message });
      try { popup.close(); } catch { /* Closing an isolated Plex tab is best-effort. */ }
    } finally { if (active.current) setConnecting(false); }
  };
  const selectServer = async (event: React.FormEvent) => {
    event.preventDefault(); setIsSaving(true); setMessage(null);
    try {
      await api.selectPlexServer(flowId, serverId, plexUrl);
      setServers([]); setFlowId(''); await loadSettings();
      setMessage({ type: 'success', text: 'Plex connected. Your friends can now use Sign in with Plex.' });
    } catch (err: any) { setMessage({ type: 'error', text: err.response?.data?.error || 'Connection failed.' }); }
    finally { setIsSaving(false); }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setMessage(null);

    try {
      const updateData: any = {};
      if (plexUrl) {
        updateData.plexUrl = plexUrl;
      }
      if (plexToken) {
        updateData.plexToken = plexToken;
      }

      await api.updateSettings(updateData);

      setMessage({ type: 'success', text: 'Settings saved successfully' });
      await loadSettings();
      setPlexToken('');
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Failed to save settings' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setMessage(null);

    try {
      // Use values from input boxes if provided, otherwise use saved settings
      const urlToTest = plexUrl || settings.plexUrl;
      const tokenToTest = plexToken || (settings.hasPlexToken ? 'saved' : '');

      if (!urlToTest) {
        setMessage({ type: 'error', text: 'Please enter a Plex server URL' });
        setIsTesting(false);
        return;
      }

      if (!tokenToTest && !settings.hasPlexToken) {
        setMessage({ type: 'error', text: 'Please enter a Plex token' });
        setIsTesting(false);
        return;
      }

      const connected = await api.testPlexConnection(
        plexUrl || undefined,
        plexToken || undefined
      );
      if (connected) {
        setMessage({ type: 'success', text: 'Successfully connected to Plex server' });
      } else {
        setMessage({ type: 'error', text: 'Failed to connect to Plex server' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to test connection' });
    } finally {
      setIsTesting(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsChangingPassword(true);
    setPasswordMessage(null);

    // Validation
    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordMessage({ type: 'error', text: 'All fields are required' });
      setIsChangingPassword(false);
      return;
    }

    if (newPassword.length < 6) {
      setPasswordMessage({ type: 'error', text: 'New password must be at least 6 characters long' });
      setIsChangingPassword(false);
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordMessage({ type: 'error', text: 'New passwords do not match' });
      setIsChangingPassword(false);
      return;
    }

    try {
      await api.changePassword(currentPassword, newPassword);
      setPasswordMessage({ type: 'success', text: 'Password changed successfully' });

      // Clear form
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      setPasswordMessage({
        type: 'error',
        text: err.response?.data?.error || 'Failed to change password'
      });
    } finally {
      setIsChangingPassword(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header onMenuClick={toggleMobileMenu} />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar isOpen={isMobileMenuOpen} onClose={closeMobileMenu} />
          <main className="flex-1 p-4 md:p-8 overflow-y-auto flex items-center justify-center">
            <div className="text-gray-400">Loading...</div>
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header onMenuClick={toggleMobileMenu} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar isOpen={isMobileMenuOpen} onClose={closeMobileMenu} />
        <main className="flex-1 p-4 md:p-8 overflow-y-auto">
          <div className="max-w-3xl">
            <h1 className="text-2xl md:text-3xl font-bold mb-4 md:mb-6">Settings</h1>

            <div className="card p-4 md:p-6 space-y-4">
              <h2 className="text-xl font-semibold">Plex server</h2>
              <p className="text-gray-400">Connect once with the server owner account. Friends sign in with their own Plex account; they do not need a token or server address.</p>
              {settings.hasPlexToken && <p>Connected: <strong>{settings.plexServerName || 'Plex server'}</strong> <span className="text-gray-400 break-all">{settings.plexUrl}</span></p>}
              <button onClick={connectOwner} disabled={connecting || isSaving} className="btn-primary">
                {connecting ? 'Waiting for Plex…' : settings.hasPlexToken ? 'Reconnect with Plex' : 'Connect with Plex'}
              </button>
              {servers.length > 0 && <form onSubmit={selectServer} className="space-y-4">
                <label className="block">Your server
                  <select className="input mt-1" value={serverId} onChange={event => {
                    const selected = servers.find(server => server.id === event.target.value)!;
                    setServerId(selected.id);
                    setPlexUrl((selected.connections.find(item => item.local) || selected.connections[0])?.url || '');
                  }}>{servers.map(server => <option key={server.id} value={server.id}>{server.name}</option>)}</select>
                </label>
                <label className="block">Server address
                  <input className="input mt-1" type="url" required value={plexUrl} onChange={event => setPlexUrl(event.target.value)} list="plex-addresses" placeholder="http://192.168.1.10:32400" />
                </label>
                <datalist id="plex-addresses">{servers.find(server => server.id === serverId)?.connections.map(connection => <option key={connection.url} value={connection.url} />)}</datalist>
                <p className="text-sm text-gray-400">Use an address reachable from LibraryDownloadarr, usually your NAS LAN address and Plex port. In a container, localhost refers to the container itself.</p>
                <button className="btn-primary" disabled={isSaving}>{isSaving ? 'Checking…' : 'Use this server'}</button>
              </form>}
              {message && <p role="status" className={message.type === 'error' ? 'text-red-400 break-words' : 'text-green-400'}>{message.text}</p>}
              <details className="pt-3 border-t border-dark-50">
                <summary className="cursor-pointer text-sm text-gray-400">Advanced: manual connection</summary>
                <form onSubmit={handleSave} className="space-y-4 mt-4">
                  <label className="block">Plex URL<input type="url" className="input mt-1" value={plexUrl} onChange={event => setPlexUrl(event.target.value)} /></label>
                  <label className="block">Plex token<input type="password" className="input mt-1" value={plexToken} onChange={event => setPlexToken(event.target.value)} placeholder={settings.hasPlexToken ? 'Leave empty to keep saved token' : 'Server owner token'} /></label>
                  <div className="flex gap-3"><button disabled={isSaving} className="btn-primary">Save</button><button type="button" onClick={handleTestConnection} disabled={isTesting} className="btn-secondary">{isTesting ? 'Testing…' : 'Test connection'}</button></div>
                </form>
              </details>
            </div>

            <div className="card p-4 md:p-6 mt-4 md:mt-6">
              <h2 className="text-xl md:text-2xl font-semibold mb-4">Change Password</h2>
              <form onSubmit={handleChangePassword} className="space-y-3 md:space-y-4">
                <div>
                  <label className="block text-sm md:text-base font-medium mb-2">Current Password</label>
                  <input
                    type="password"
                    className="input text-sm md:text-base"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Enter current password"
                  />
                </div>

                <div>
                  <label className="block text-sm md:text-base font-medium mb-2">New Password</label>
                  <input
                    type="password"
                    className="input text-sm md:text-base"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Enter new password (min. 6 characters)"
                  />
                </div>

                <div>
                  <label className="block text-sm md:text-base font-medium mb-2">Confirm New Password</label>
                  <input
                    type="password"
                    className="input text-sm md:text-base"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter new password"
                  />
                </div>

                {passwordMessage && (
                  <div
                    className={`px-4 py-3 rounded-lg text-xs md:text-sm ${
                      passwordMessage.type === 'success'
                        ? 'bg-green-500/10 border border-green-500/20 text-green-400'
                        : 'bg-red-500/10 border border-red-500/20 text-red-400'
                    }`}
                  >
                    {passwordMessage.text}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isChangingPassword}
                  className="btn-primary text-sm md:text-base"
                >
                  {isChangingPassword ? 'Changing Password...' : 'Change Password'}
                </button>
              </form>
            </div>

            <div className="card p-4 md:p-6 mt-4 md:mt-6">
              <h2 className="text-xl md:text-2xl font-semibold mb-4">About</h2>
              <div className="space-y-2 text-xs md:text-sm text-gray-400">
                <p>
                  <span className="font-medium text-gray-300">LibraryDownloadarr</span> v1.0.0
                </p>
                <p>A modern web application for downloading media from your media library server</p>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
};
