// FOR TESTS ONLY, and never in a release (tools/build.mjs reads src/ alone,
// and src/ has no way to loosen its terms).
//
// A camera sends nothing unless the call agreed an AES-GCM suite (src/rtc/
// terms.js). Two browsers on a call with each other agree AES-CM: each
// lists it first, and nothing a page can do changes that. Only an app,
// which lists AES-GCM alone, brings a browser to AES-GCM. So a page of
// tests, whose far end is another browser, can see the refusal but nothing
// after it. These terms take any suite, so that everything else about a
// session (the offer, the ready connection, play and pause, the caps) can
// be tried between two ends in one page. The call with the app, on the real
// terms, is the other half of the proof (scripts/web-camera-bridge/ in the
// apps' repository).

/** @type {import('../src/rtc/terms.js').Terms} */
export const ANY_SUITE_FOR_TESTS = Object.freeze({ srtp: (cipher) => typeof cipher === 'string' && cipher !== '' });
