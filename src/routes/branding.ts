const BRAND_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-hidden="true"><defs><linearGradient id="hd-g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#2563eb"/><stop offset="100%" stop-color="#1d4ed8"/></linearGradient></defs><rect x="8" y="8" width="112" height="112" rx="24" fill="url(#hd-g)"/><path fill="#ffffff" d="M36 35h16v22h24V35h16v58H76V71H52v22H36z"/><path fill="#93c5fd" d="M30 99h68a9 9 0 0 1 0 18H30a9 9 0 0 1 0-18z" opacity=".45"/></svg>`;

export function faviconDataUri(): string {
  return `data:image/svg+xml,${encodeURIComponent(BRAND_ICON_SVG)}`;
}

export function brandIconSvg(): string {
  return BRAND_ICON_SVG;
}
