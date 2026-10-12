import { useEffect, type CSSProperties } from 'react';

const st = (s: string) => Object.fromEntries(s.split(';').filter(Boolean).map((p) => p.split(':').map((x) => x.trim()))) as CSSProperties;

// Static decoration, parsed once at module load.
const FLIES = [
  '--x:30%;--y:22%;--s:3px;--d:11.7s;--b:3.1s;--dx:-34px;--dy:-36px;--delay:-9.6s',
  '--x:38%;--y:62%;--s:2px;--d:8.2s;--b:2.3s;--dx:24px;--dy:-18px;--delay:-0.3s',
  '--x:47%;--y:18%;--s:4px;--d:8.5s;--b:2.8s;--dx:30px;--dy:9px;--delay:-0.5s',
  '--x:55%;--y:70%;--s:4px;--d:6.7s;--b:2.7s;--dx:40px;--dy:-38px;--delay:-3.9s',
  '--x:62%;--y:30%;--s:4px;--d:6.3s;--b:2.7s;--dx:31px;--dy:-28px;--delay:-1.8s',
  '--x:70%;--y:55%;--s:3px;--d:9.2s;--b:3.5s;--dx:31px;--dy:-22px;--delay:-0.9s',
  '--x:78%;--y:24%;--s:4px;--d:9.8s;--b:3.1s;--dx:30px;--dy:-37px;--delay:-5.5s',
  '--x:86%;--y:64%;--s:4px;--d:7.2s;--b:3.8s;--dx:14px;--dy:-5px;--delay:-3.4s',
  '--x:93%;--y:38%;--s:4px;--d:8.2s;--b:2.8s;--dx:-17px;--dy:-14px;--delay:-0.7s',
  '--x:44%;--y:84%;--s:3px;--d:9.2s;--b:4.2s;--dx:17px;--dy:-9px;--delay:-5.6s',
  '--x:66%;--y:86%;--s:2px;--d:6.7s;--b:3.2s;--dx:3px;--dy:-26px;--delay:-6.3s',
  '--x:25%;--y:74%;--s:4px;--d:6.2s;--b:3.7s;--dx:31px;--dy:-5px;--delay:-2.1s',
  '--x:6%;--y:30%;--s:3px;--d:9.6s;--b:3.5s;--dx:18px;--dy:-37px;--delay:-8.1s',
  '--x:14%;--y:82%;--s:3px;--d:8.8s;--b:3.7s;--dx:-33px;--dy:-6px;--delay:-5.7s',
  '--x:21%;--y:12%;--s:5px;--d:10.9s;--b:2.9s;--dx:9px;--dy:-1px;--delay:-0.2s',
  '--x:52%;--y:44%;--s:4px;--d:8.1s;--b:3.6s;--dx:23px;--dy:-38px;--delay:-1.8s',
].map(st);
const SPARKS: [string, CSSProperties][] = [
  ['spark', st('--x:34%;--y:30%;--t:3.2s')],
  ['spark', st('--x:58%;--y:22%;--t:4.1s;--delay:-1.3s')],
  ['spark spark--sm', st('--x:50%;--y:58%;--t:2.7s;--delay:-.8s')],
  ['spark spark--sm', st('--x:9%;--y:16%;--t:3.6s;--delay:-2s')],
];

export function Credits() {
  // house credits.js binds an IntersectionObserver to .creator; run it once on mount.
  useEffect(() => { const url = '/_house/credits/credits.js'; void import(/* @vite-ignore */ url); }, []);
  return (
    <section className="section span-12 creator" aria-labelledby="h-creator">
      <div className="card">
        <div className="card__head"><h2 id="h-creator">Credits</h2></div>
        <div className="card__body creator__body">
          <div className="creator__fx" aria-hidden="true">
            {FLIES.map((style, i) => <i key={i} style={style} />)}
            {SPARKS.map(([cls, style], i) => <b key={i} className={cls} style={style} />)}
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
      </div>
    </section>
  );
}
