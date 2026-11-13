'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { Mail, Lock, User, Loader2, LogIn, UserPlus } from 'lucide-react';

export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (mode === 'signup') {
        const r = await fetch('/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, password }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error ?? 'Signup failed');
      }
      const res = await signIn('credentials', { email, password, redirect: false });
      if (!res || res.error) throw new Error('Invalid email or password');
      router.replace('/');
    } catch (err) {
      setError((err as Error)?.message ?? 'Something went wrong');
    } finally { setBusy(false); }
  };

  const field = 'w-full rounded-lg bg-background/70 py-2.5 pl-10 pr-3 text-sm shadow-inner outline-none ring-1 ring-white/5 focus:ring-primary';
  return (
    <form onSubmit={submit} className="space-y-4">
      {mode === 'signup' && (
        <div className="relative">
          <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input className={field} placeholder="Name (optional)" value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)} aria-label="Name" />
        </div>
      )}
      <div className="relative">
        <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input className={field} type="email" required placeholder="Email" value={email} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} aria-label="Email" name="email" />
      </div>
      <div className="relative">
        <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input className={field} type="password" required minLength={6} placeholder="Password (min 6 characters)" value={password} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)} aria-label="Password" name="password" />
      </div>
      {error && <p className="rounded-md bg-destructive/15 px-3 py-2 text-xs text-red-200">{error}</p>}
      <button type="submit" disabled={busy} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition hover:bg-primary/85 disabled:opacity-60">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : mode === 'login' ? <LogIn className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />}
        {mode === 'login' ? 'Sign in' : 'Create account'}
      </button>
      <p className="text-center text-xs text-muted-foreground">
        {mode === 'login' ? <>New here? <Link href="/signup" className="text-primary hover:underline">Create an account</Link></> : <>Already registered? <Link href="/login" className="text-primary hover:underline">Sign in</Link></>}
      </p>
    </form>
  );
}

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm rounded-xl bg-card/85 p-6 shadow-2xl backdrop-blur">
        <Link href="/" className="mb-5 flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.jpg" alt="Snapspace logo" className="h-8 w-8 rounded-md object-cover" />
          <span className="font-display text-lg font-bold">Snap<span className="text-primary">space</span></span>
        </Link>
        <h1 className="font-display text-xl font-semibold">{title}</h1>
        <p className="mb-5 mt-1 text-xs text-muted-foreground">{subtitle}</p>
        {children}
      </div>
    </main>
  );
}
