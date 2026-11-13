import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { AuthForm, AuthShell } from '@/components/auth-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect('/');
  return (
    <AuthShell title="Sign in" subtitle="Access your saved SPHEREx fields and targets.">
      <AuthForm mode="login" />
    </AuthShell>
  );
}
