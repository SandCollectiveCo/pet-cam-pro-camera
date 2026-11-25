// The terms a camera's call is held to (docs/API.md, Realtime, Media;
// docs/WEB-CAMERA.md § 5 and decisions 6 and 7).
//
// SRTP with AES-GCM only. A browser can't say so in its offer: which suite
// a call uses is agreed in the DTLS handshake, where a browser lists AES-CM
// first and the apps list only AES-GCM, so a call with an app comes out on
// AES-GCM. What the page can do is refuse anything else: a session carries
// no picture and no sound until the connection's own report says it agreed
// an AES-GCM suite, with the certificate the signed answer named.
//
// The RTP header extensions travel in the clear, as SRTP leaves them, so a
// camera negotiates only the three a call can't do without. The audio
// level, which would tell a relay how loud the room is packet by packet, is
// never among them, and nor is anything else a browser would add.

/** Whether a call's SRTP suite is one of the AES-GCM ones, as a
 * connection's report names it. @param {unknown} cipher */
export const isGcm = (cipher) => typeof cipher === 'string' && /^(SRTP_)?AEAD_AES_(128|256)_GCM$/.test(cipher);

/** The header extensions a camera offers: which stream a packet belongs to,
 * when it was sent, and its number in the call (the last two are what the
 * sender measures the link with). */
export const HEADER_EXTENSIONS = Object.freeze([
    'urn:ietf:params:rtp-hdrext:sdes:mid',
    'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
    'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
]);

/** The video codecs a camera offers, in order: H.264, with VP8 as the
 * fallback the apps already decode. Nothing else is offered. */
export const VIDEO_CODECS = Object.freeze(['video/H264', 'video/VP8']);

/** What rides along with them: retransmissions and error correction. */
export const VIDEO_HELPERS = Object.freeze(['video/rtx', 'video/red', 'video/ulpfec', 'video/flexfec-03']);

/**
 * The terms a session is held to before it carries anything.
 * @typedef {object} Terms
 * @property {(cipher: unknown) => boolean} srtp whether a call's SRTP suite will do
 */

/** @type {Terms} */
export const TERMS = Object.freeze({ srtp: isGcm });
