import type { Metadata, Viewport } from 'next'
import { DM_Sans, Plus_Jakarta_Sans, JetBrains_Mono } from 'next/font/google'
import './globals.css'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import { ChunkLoadErrorHandler } from '@/components/chunk-load-error-handler'
import { Providers } from '@/components/providers'

export const dynamic = 'force-dynamic'

const dmSans = DM_Sans({ subsets: ['latin'], variable: '--font-sans' })
const jakartaSans = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-display' })
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' })

export async function generateMetadata(): Promise<Metadata> {
  const base = process.env.NEXTAUTH_URL ?? 'http://localhost:3000'
  return {
    metadataBase: new URL(base),
    title: 'Snapspace – Infrared Time-Domain Explorer',
    description: 'Snap through NASA SPHEREx DR1 all-sky infrared epochs to catch brown dwarfs, asteroids and variable stars in motion.',
    manifest: '/manifest.webmanifest',
    icons: { icon: '/logo.jpg', apple: '/logo.jpg' },
    appleWebApp: { capable: true, title: 'Snapspace' },
    openGraph: { title: 'Snapspace', description: 'Multi-epoch SPHEREx infrared blink comparator', images: ['/logo.jpg'] },
  }
}

export const viewport: Viewport = { themeColor: '#05070d' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script src="https://apps.abacus.ai/chatllm/appllm-lib.js"></script>
      </head>
      <body className={`${dmSans.variable} ${jakartaSans.variable} ${jetbrainsMono.variable} font-sans starfield min-h-screen`}>
        <ThemeProvider attribute="class" defaultTheme="dark" forcedTheme="dark" disableTransitionOnChange>
          <Providers>{children}</Providers>
          <Toaster />
          {/* IMPORTANT: Do not remove — handles chunk loading race conditions in the dev server */}
          <ChunkLoadErrorHandler />
        </ThemeProvider>
      </body>
    </html>
  )
}
