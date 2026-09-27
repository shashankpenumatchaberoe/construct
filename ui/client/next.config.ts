import path from 'node:path';
import type { NextConfig } from 'next';

// ui/server (Express + ws) stays a fully separate process, called from this
// Next.js app exactly like it was called from the Vite app before (see the
// decision recorded on epic #64: Next.js API routes don't handle long-lived
// WebSocket connections well, so the wizard's transport stays on Express).
//
// Decision (documented on #70): rather than a Next.js rewrite proxy for
// `/api/*` (which reliably forwards plain HTTP but not a WebSocket upgrade
// without a custom server — reintroducing exactly the coupling #64 decided
// to avoid), every request — REST and the wizard's WebSocket alike — goes
// straight to ui/server's own origin (see lib/apiBase.ts), which already
// runs with `cors()` enabled for every origin. One mechanism for both kinds
// of call, instead of a proxy for one and a direct connection for the
// other. No rewrite/proxy config is needed here as a result.
// #454: threadmark-react (the dev-only design-review overlay) must be impossible to reach in
// the hosted build, not merely unreachable at runtime. features/design-review's own loader
// already gates the dynamic import behind NEXT_PUBLIC_REVIEW_OVERLAY=1, but that alone is not
// enough -- confirmed against a real `next build`: webpack still creates a (never-requested)
// chunk for the import() call regardless of the surrounding runtime check, and Next's own
// react-loadable-manifest bookkeeping records the source-level "...Loader.ts -> threadmark-react"
// import specifier text no matter what it resolves to. So when the flag is not "1" at BUILD time,
// this swaps the whole loader module for a stub that contains no reference to threadmark-react at
// all (ReviewOverlayLoader.stub.ts) -- the real package is then never read, resolved or emitted
// into any output file (client or server), and the literal import specifier never exists in the
// compiled source for react-loadable-manifest to record either. The package-name alias below is
// belt-and-suspenders in case anything else ever imports it directly. Grepping `.next/` for
// "threadmark" after a default (flag-off) build now finds nothing served -- only the unrelated,
// never-shipped `.next/cache/.tsbuildinfo` TypeScript cache (records type-only imports; not
// served to a browser or included in `next start`).
const nextConfig: NextConfig = {
  // #485: a self-contained `.next/standalone` output (server.js + only the
  // node_modules it actually needs) is what both the Docker image and the
  // `@line/cockpit` npm package ship — the correct shape for a compiled
  // redistributable instead of requiring a full `npm install` on the target.
  output: 'standalone',
  // #595: the dev-mode indicator (<nextjs-portal>, the floating "N" badge)
  // sits over whatever's underneath and swallows pointer events on the real
  // page — Playwright saw it intercept a click in the Pages Editor tree
  // panel. It only ever renders in `next dev`; a production/standalone
  // build never includes it regardless of this flag. Off everywhere in dev
  // (not just under Playwright) so the app behaves the same for a human
  // clicking near the same corner.
  devIndicators: false,
  turbopack: {
    root: path.resolve(__dirname),
  },
  webpack: (config) => {
    if (process.env.NEXT_PUBLIC_REVIEW_OVERLAY !== '1') {
      config.resolve.alias = {
        ...config.resolve.alias,
        [path.resolve(__dirname, 'features/design-review/services/ReviewOverlayLoader.ts')]: path.resolve(
          __dirname,
          'features/design-review/services/ReviewOverlayLoader.stub.ts',
        ),
        'threadmark-react$': path.resolve(__dirname, 'features/design-review/services/reviewOverlayStub.ts'),
      };
    }
    return config;
  },
};

export default nextConfig;
