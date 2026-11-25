// What a release is built as. Everything a build needs to know that isn't
// its own source is here, in the commit, so the same commit gives the same
// bytes.

/**
 * This release's number: 1 for the first one published, and one higher for
 * each after it, never lower (a viewer's app refuses a release older than
 * one it has taken). It is the `release` of the signed list (tools/
 * build.mjs) and the number in the camera's `app_version`.
 */
export const RELEASE = 1;

/** What a camera says it is, in its status and when it registers: "web (1)". */
export const APP_VERSION = `web (${RELEASE})`;

/**
 * The name the page is served under: one of petcampro.com's, a CNAME to the
 * organization's pages at GitHub and nothing else, so that the address a
 * person sees is ours to read (docs/WEB-CAMERA.md § 2, The page's name).
 * The name is settled (2026-11-25).
 */
export const PAGE_NAME = 'camera.petcampro.com';

/**
 * The origin the page is served from, which is the page's alone: nothing
 * else is ever served under that name. Storage and the camera's permission
 * belong to an origin. The page still keeps what it stores under names of
 * its own, and takes nothing it finds there on trust. It is https and the
 * name, written out: a build checks the two agree (tools/build.mjs).
 */
export const PAGE_ORIGIN = 'https://camera.petcampro.com';

/**
 * The path it is served under on that origin: the root. A repository given
 * a name of its own is served there, so the repository's name is in no
 * address. Nothing in the page rests on that: every address it loads is a
 * file's name alone, relative to its own, so the same files serve under any
 * path.
 */
export const PAGE_PATH = '/';

/**
 * The page's own address, the origin and the path, ending in its slash:
 * what a release's list is signed for, what a viewer's link to it begins
 * with, and what both compare whole.
 */
export const PAGE = `${PAGE_ORIGIN}${PAGE_PATH}`;

/** The Worker a release's camera talks to, and the only address a release's
 * page may connect to (its Content-Security-Policy is written from this:
 * tools/build.mjs). */
export const API = 'https://api.petcampro.com';
