import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';

export function LoginPage() {
  const { login, completeTotpLogin, loginWithPasskey } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitPasskey = async () => {
    setError(null);
    setBusy(true);
    try {
      await loginWithPasskey();
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Passkey sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await login(username, password);
      if (result.requiresTotp) {
        setChallengeToken(result.challengeToken);
      } else {
        navigate('/');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!challengeToken) return;
    setError(null);
    setBusy(true);
    try {
      await completeTotpLogin(challengeToken, code);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  };

  if (challengeToken) {
    return (
      <div className="login-page">
        <form className="login-card" onSubmit={submitCode}>
          <div className="brand brand-large">
            <span className="brand-icon">▣</span> GameDock Manager
          </div>
          <div className="form-row">
            <label htmlFor="totp-code">Authenticator code</label>
            <input
              id="totp-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
              required
            />
          </div>
          {error && <div className="error-text">{error}</div>}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? 'Verifying...' : 'Verify'}
          </button>
          <p className="login-hint">
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setChallengeToken(null);
                setCode('');
                setError(null);
              }}
            >
              Back to sign in
            </button>
          </p>
        </form>
      </div>
    );
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submitPassword}>
        <div className="brand brand-large">
          <span className="brand-icon">▣</span> GameDock Manager
        </div>
        <div className="form-row">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </div>
        <div className="form-row">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        {error && <div className="error-text">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Signing in...' : 'Sign in'}
        </button>
        <button type="button" className="btn btn-block" disabled={busy} onClick={submitPasskey}>
          Sign in with a passkey
        </button>
        <p className="login-hint">
          First run? Create an admin with <code>pnpm gamedock user:create-admin</code>
        </p>
      </form>
    </div>
  );
}
