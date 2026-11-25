# Pet Cam Pro's camera page

The page a Pet Cam Pro **temporary camera** runs: a phone, a tablet or a computer borrowed as a camera for a day, a week at most. Someone already in a home starts it from the Pet Cam Pro app, the borrowed device opens this page from the code the app shows, both show the same six digits, and once the app approves it, the home's devices can watch it until its time is up or anyone ends it.

It is served at **https://camera.petcampro.com/**, from this repository alone.

## What it holds, and what it doesn't

- **A key of its own**, handed to it sealed for its own key pair when it's approved. Never a key of the home's: it can't open anything the home keeps, or anything another camera sends.
- **Live video and sound, end to end encrypted**: WebRTC, on AES-GCM or not at all, each call's certificate checked against a signed offer. Stills for a viewer's grid, sealed. Nothing stored anywhere.
- **No third-party code**, no service worker, no cookies, nothing that reloads it from afar. A Content-Security-Policy in the page, and every file it loads named by its hash and checked by the browser.
- **The camera and the microphone only after a tap**, and only while the page is open in front. It ends by itself at its time.

## How a release is made, published and checked

1. **The same bytes every time.** The page is built from this source by `tools/build.mjs`, with nothing installed and nothing fetched: no time, path or machine goes in. `npm run verify` builds it twice, apart, and compares them byte for byte.
2. **Signed on one Mac.** A release's list of files (`release.json`) is signed with a key made in that Mac's Secure Enclave, which never gives up its private half: it can't be copied to a server, a build machine or a backup. Each signature asks for Touch ID or the Mac's password. `tools/release-key.swift` holds the key; `tools/sign-release.mjs` builds the page, signs its list, and checks the result as the apps check one.
3. **Published by this repository's workflow, and only if signed.** `release/release.json` is the signed list for the source at this commit, and `release/keys.json` the public halves of the release keys, the same the apps carry. `.github/workflows/publish.yml` builds the page from this commit and publishes it only if the build is exactly what the signed list says, file for file, and one of those keys signed it (`tools/publish-check.mjs`). It holds no key and signs nothing.
4. **Checked by the app before any camera starts.** The app looks up where the page's name points (it has to be GitHub's servers for this repository), fetches `release.json`, checks its signature with the key it carries and its release number against the newest it has taken, and compares the page's address and every file with the list. A page that isn't a signed release gets no code, and no camera starts on it.

If the Mac that holds the release key is lost or erased, so is the key. That's why the apps carry a list of release keys: a second key, made the same way on another Mac, signs if the first can't.

## The watch on the name

`.github/workflows/watch.yml` runs `tools/watch.mjs` every hour, from outside the company that holds the name, and reads the certificate logs every sixth hour and on every run by hand:

- **Where the name points**, asked of four public resolvers (Cloudflare, Google, Quad9 and OpenDNS) over HTTPS: a CNAME to GitHub's own name for these pages, and no address that isn't one of its.
- **Which certificate GitHub's servers serve** for the name, asked of them directly.
- **Every certificate the public logs hold** for the name, which browsers require of any certificate they take. One for the name itself has to be Let's Encrypt's and one GitHub has been seen serving (its record is `watch/served.json`, which the watch keeps). The zone's own wildcard certificates cover the name too: they belong to the company that holds the name, and serve it only through that company's own proxy, which the resolvers would show.
- **That the page's address serves a signed release**, every file as listed.

Anything that isn't GitHub's fails the run, and a failed run mails the person who set the workflow up. Before the name exists, it says "not there yet" and passes. GitHub stops a quiet repository's schedules after 60 days, so the watch commits the date of its last check when the repository has had no commit for 45. If its schedule ever stops anyway, enabling it again by hand on the Actions tab starts it, and mails go to whoever did that.

Anyone can run it: `node tools/watch.mjs`. It sends only the page's public name, to public services.

## Running it

Node 22 or later. Nothing is installed: `package.json` lists no dependency.

```bash
npm test                 # every test that runs in Node, a build checked against the page's rules among them
npm run test:browsers    # the same tests, and the browser-only ones, in headless Chrome and in Safari (on a Mac)
npm run test:release     # a built page in headless Chrome, at a root and under a path
npm run verify           # builds twice, apart, compares the bytes, and goes over the result
npm run watch            # the watch on the name, from here
```

On the Mac that holds the release key, and nowhere else:

```bash
npm run release:key      # makes the release key in this Mac's Secure Enclave, once, and prints its public half
npm run release:sign     # builds the page, signs its list (Touch ID), checks it, and writes release/release.json
npm run test:release-key # the key tool, with throwaway keys that leave nothing behind
```

No test or dev page ever turns on a real camera or microphone: they draw a picture and make a tone.

## What isn't here

The apps and their server are Pet Cam Pro's own, and not published. The page's comments cite their documents by section: `docs/API.md` is the contract between this page and the apps (Temporary cameras, The camera page), and `docs/WEB-CAMERA.md` the plan the page was built to. The test vectors in `vectors/` are copies of the apps' own: the apps, their server and this page are all held to the same files.
