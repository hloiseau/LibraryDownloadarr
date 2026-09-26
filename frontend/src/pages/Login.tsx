import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { api } from '../services/api';

export const Login: React.FC = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isPlexLoading, setIsPlexLoading] = useState(false);
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const navigate = useNavigate();
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const { login, setUser, setToken, token, user } = useAuthStore();

  // Redirect to home if already logged in
  useEffect(() => {
    if (token && user) {
      navigate('/', { replace: true });
    }
  }, [token, user, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      await login(username, password);
      navigate('/');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePlexLogin = async () => {
    setError('');
    setIsPlexLoading(true);

    // IMPORTANT: Open window immediately (synchronously) before any async operations
    // Mobile browsers block window.open() if it's not directly in the click handler
    const authWindow = window.open('about:blank', '_blank', 'width=600,height=700');

    try {
      // Generate PIN
      const pin = await api.generatePlexPin();

      // Navigate the already-opened window to Plex auth
      if (authWindow) {
        authWindow.location.href = pin.url;
      } else {
        // Fallback if popup was blocked
        setError('Popup blocked. Please allow popups for this site and try again.');
        setIsPlexLoading(false);
        return;
      }

      const deadline = Date.now() + 5 * 60 * 1000;
      while (active.current && Date.now() < deadline) {
        const response = await api.authenticatePlexPin(pin.flowId);
        if (!active.current) return;
        if (response) {
          try { authWindow.close(); } catch { /* Closing an isolated Plex tab is best-effort. */ }
          setUser(response.user);
          setToken(response.token);
          setIsPlexLoading(false);
          navigate('/');
          return;
        }
        // COOP isolation can report an open Plex tab as closed. Only the
        // backend authorization result (or expiry) determines sign-in status.
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      if (active.current) throw new Error('Plex sign-in expired. Please try again.');
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to initiate Plex login');
      setIsPlexLoading(false);
      // Close the blank window if PIN generation failed
      if (authWindow) {
        try { authWindow.close(); } catch { /* Closing an isolated Plex tab is best-effort. */ }
      }
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-dark p-4">
      <div className="max-w-md w-full">
        <div className="text-center mb-6 md:mb-8">
          <h1 className="text-3xl md:text-4xl font-bold bg-gradient-to-r from-primary-500 to-secondary-500 bg-clip-text text-transparent mb-2">
            LibraryDownloadarr
          </h1>
          <p className="text-sm md:text-base text-gray-400">Your media library, ready to download</p>
        </div>

        <div className="card p-6 md:p-8">
          {/* Primary: Plex Login */}
          <div className="text-center mb-6">
            <h2 className="text-xl md:text-2xl font-bold mb-2">Sign In</h2>
            <p className="text-sm md:text-base text-gray-400">Use your Plex account to get started</p>
          </div>

          <button
            onClick={handlePlexLogin}
            disabled={isPlexLoading}
            className="btn-primary w-full flex items-center justify-center space-x-3 text-base md:text-lg py-4 font-semibold shadow-lg hover:shadow-xl transition-shadow"
          >
            <span className="text-2xl md:text-3xl">🎬</span>
            <span>{isPlexLoading ? 'Waiting for Plex...' : 'Sign in with Plex'}</span>
          </button>

          {isPlexLoading && (
            <div className="mt-4 p-4 bg-primary-500/10 border border-primary-500/20 rounded-lg">
              <p className="text-xs md:text-sm text-gray-300 text-center">
                <strong>Waiting for authorization...</strong>
                <br />
                Complete the login in the popup window.
              </p>
            </div>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-lg text-xs md:text-sm mt-4">
              {error}
            </div>
          )}

          {/* Secondary: Admin Login */}
          <div className="mt-8 pt-6 border-t border-dark-50">
            {!showAdminLogin ? (
              <button
                onClick={() => setShowAdminLogin(true)}
                className="text-sm text-gray-400 hover:text-gray-300 transition-colors w-full text-center"
              >
                Administrator login
              </button>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-300">Administrator Login</h3>
                  <button
                    onClick={() => {
                      setShowAdminLogin(false);
                      setError('');
                      setUsername('');
                      setPassword('');
                    }}
                    className="text-xs text-gray-500 hover:text-gray-400"
                  >
                    Cancel
                  </button>
                </div>

                <form onSubmit={handleSubmit} className="space-y-3">
                  <div>
                    <label className="block text-xs md:text-sm font-medium mb-1.5 text-gray-300">Username</label>
                    <input
                      type="text"
                      required
                      className="input text-sm"
                      placeholder="Admin username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                    />
                  </div>

                  <div>
                    <label className="block text-xs md:text-sm font-medium mb-1.5 text-gray-300">Password</label>
                    <input
                      type="password"
                      required
                      className="input text-sm"
                      placeholder="Admin password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>

                  <button type="submit" disabled={isLoading} className="btn-secondary w-full text-sm py-2.5">
                    {isLoading ? 'Logging in...' : 'Sign In as Admin'}
                  </button>
                </form>
              </div>
            )}
          </div>
        </div>

        {/* Helpful note */}
        <div className="mt-6 text-center">
          <p className="text-xs text-gray-500">
            Most users should sign in with Plex.
            <br />
            Administrator access is only needed for system configuration.
          </p>
        </div>
      </div>
    </div>
  );
};
