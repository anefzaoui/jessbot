// Site readers for web_read (decision #135): a small table so each adapter stays isolated. URL readers (YouTube, X,
// Reddit) replace the generic page read for their addresses; content readers (PDF, feeds) take over when the response
// turns out to be that kind of file, whatever the address. Any failure falls back to the generic reader (read.js).
import { videoIdOf, readYouTube } from './youtube.js';
import { tweetRef, readX } from './x.js';
import { threadRef, readReddit } from './reddit.js';

export { isPdf, pdfDocument, PDF_MAX_BYTES } from './pdf.js';
export { feedKind, renderFeed, renderOpml, normalizeFeed } from './feed.js';

/** name, match(url) → bool, read(url, helpers) → doc. helpers: { withPage, fetchJson, walls, dismissConsent, signal, lang }. */
export const SITE_READERS = [
  { name: 'youtube', label: 'YouTube', match: u => !!videoIdOf(u), read: readYouTube },
  { name: 'x', label: 'X', match: u => !!tweetRef(u), read: readX },
  { name: 'reddit', label: 'Reddit', match: u => !!threadRef(u), read: readReddit },
];

export const siteReaderFor = url => SITE_READERS.find(r => r.match(url)) || null;
