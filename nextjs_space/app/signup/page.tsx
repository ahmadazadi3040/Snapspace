import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { AuthForm, AuthShell } from '@/components/auth-form';

export const dynamic = 'force-dynamic';

export default async function SignupPage() {
  const session = await auth();
  if (session?.user) redirect('/');
  return (
    <AuthShell title="Create an account" subtitle="Save targets and come back to blink them anytime.">
      <AuthForm mode="signup" />
    </AuthShell>
  );
}
