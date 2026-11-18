import { useEffect, useRef } from 'react';
import { BrandLogo } from './BrandLogo';
import { initLogoResize } from '../brand/logo-resize';

export function Credits() {
  const sign = useRef<HTMLDivElement>(null);
  useEffect(() => initLogoResize(sign.current!), []);
  // house credits.js binds an IntersectionObserver to .creator; run it once on mount.
  useEffect(() => { const url = '/_house/credits/credits.js'; void import(/* @vite-ignore */ url); }, []);
  return (
    <section className="section span-12 creator" aria-labelledby="h-creator">
      <div className="card">
        <div className="card__head"><h2 id="h-creator">Credits</h2></div>
        <div className="card__body creator__body">
          <div className="creator__fx" aria-hidden="true">
            {Array.from({ length: 16 }, (_, i) => <i key={i} />)}
            <b className="spark" /><b className="spark" /><b className="spark spark--sm" /><b className="spark spark--sm" />
          </div>
          <div className="creator__art" aria-hidden="true">
            <img src="/_house/credits/creator.webp" alt="" width="456" height="613" loading="lazy" decoding="async" />
          </div>
          <div className="creator__text">
            <p className="creator__eyebrow">Made by</p>
            <p className="creator__name"><span>Vin</span></p>
            <p className="creator__blurb">DueReminder was designed and built by Vin. Find more of my work on my website, or say hi on Instagram and X.</p>
            <ul className="creator__links">
              <li><a href="https://vwesley.dev" target="_blank" rel="noopener">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>
                <span>vwesley.dev</span></a></li>
              <li><a href="https://www.instagram.com/vinnql/" target="_blank" rel="noopener">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1" className="fill"/></svg>
                <span>@vinnql</span><span className="sr-only"> on Instagram</span></a></li>
              <li><a href="https://x.com/Vin_Koe" target="_blank" rel="noopener">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path className="fill" d="M17.8 3h3.1l-6.8 7.8L22 21h-6.2l-4.9-6.4L5.3 21H2.2l7.3-8.3L2 3h6.4l4.4 5.8L17.8 3zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5z"/></svg>
                <span>@Vin_Koe</span><span className="sr-only"> on X (Twitter)</span></a></li>
            </ul>
          </div>
        </div>
        <div className="studio-signoff" ref={sign}>
          <a href="https://vwesley.dev" className="studio-logo-link" data-logo-link title="Drag sideways to resize" target="_blank" rel="noopener">
            <BrandLogo id="bl" />
          </a>
          <p><span>Copyright {new Date().getFullYear()} Vin's Atelier.</span> <span>Designed and built by Vin.</span></p>
          <p>Logo by <a href="https://www.instagram.com/portus_workstation/" target="_blank" rel="noopener noreferrer">@portus_workstation</a>
            {' / '}<a href="https://www.instagram.com/wason25_pz/" target="_blank" rel="noopener noreferrer">@wason25_pz</a></p>
        </div>
      </div>
    </section>
  );
}
