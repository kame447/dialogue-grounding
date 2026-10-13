import { useEffect } from 'react';

/** Tracks the visual viewport so the composer stays above the on-screen keyboard. */
export function useAppHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    const apply = () => document.documentElement.style.setProperty('--app-h', `${Math.round(vv?.height ?? window.innerHeight)}px`);
    apply();
    vv?.addEventListener('resize', apply);
    window.addEventListener('resize', apply);
    return () => {
      vv?.removeEventListener('resize', apply);
      window.removeEventListener('resize', apply);
      document.documentElement.style.removeProperty('--app-h');
    };
  }, []);
}
