// Public operator copy only; never read from a participant request or config provenance.
const DEFAULT = '実験の案内に記載された連絡先へお問い合わせください。';
export function participantContactHTML(html: string, configured: unknown): string {
  const text = typeof configured === 'string' && configured.length > 0 && configured.length <= 500 &&
    !/[\u0000-\u001f\u007f<>]/u.test(configured) ? configured : DEFAULT;
  const escaped = text.replace(/&/gu,'&amp;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
  return html.replace(/<meta name="participant-contact" content="[^"]*">/u,
    '<meta name="participant-contact" content="'+escaped+'">');
}
