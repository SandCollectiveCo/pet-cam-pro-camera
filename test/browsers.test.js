// Which browsers the first version takes, by what each says it is
// (docs/WEB-CAMERA.md § 1 and decision 6: a browser that hasn't passed its
// check is left out). Chrome from 120, Edge, and Safari from 16.4 come
// first; Firefox hasn't been on a call with the app yet.

import { canBeACamera, isLeftOut } from '../src/app.js';
import { assert, suite, test } from './lib/harness.js';

const chromeOnAndroid = (version) => `Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Mobile Safari/537.36`;
const chromeOnAMac = (version) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`;
const edgeOnWindows = (version) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36 Edg/${version}.0.0.0`;
const safariOnAMac = (version) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Safari/605.1.15`;
const safariOnAnIPhone = (system) => `Mozilla/5.0 (iPhone; CPU iPhone OS ${system.replace('.', '_')} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${system} Mobile/15E148 Safari/604.1`;
const safariOnAnIPad = (system) => `Mozilla/5.0 (iPad; CPU OS ${system.replace('.', '_')} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${system} Mobile/15E148 Safari/604.1`;
const chromeOnAnIPhone = (system) => `Mozilla/5.0 (iPhone; CPU iPhone OS ${system.replace('.', '_')} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1`;

suite('which browsers');

test('takes Chrome from 120, Edge, and Safari from 16.4, and leaves the rest out', () => {
    const takes = [
        chromeOnAndroid(158), chromeOnAndroid(120), chromeOnAndroid(138), chromeOnAMac(131), edgeOnWindows(130),
        'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        safariOnAMac('27.2'), safariOnAMac('17.6.1'), safariOnAMac('16.4'), safariOnAMac('16.6.1'),
        safariOnAnIPhone('16.4'), safariOnAnIPhone('17.5'), safariOnAnIPhone('18.1'), safariOnAnIPad('16.4'), safariOnAnIPad('18.0'),
    ];
    const leavesOut = [
        // Before AES-GCM was offered (Android 7's last Chrome among them).
        chromeOnAndroid(119), chromeOnAndroid(98), chromeOnAMac(119), edgeOnWindows(119),
        // Before a page could keep a screen awake.
        safariOnAMac('16.3'), safariOnAMac('15.6.1'), safariOnAMac('14.1'), safariOnAnIPhone('16.3'), safariOnAnIPhone('15.8'), safariOnAnIPad('15.7'),
        // On an iPhone every browser is Safari's engine at the system's version.
        chromeOnAnIPhone('16.2'),
        // Firefox, which hasn't been on a call with the app, wherever it runs.
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
        'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15',
    ];
    for (const agent of takes) assert.equal(isLeftOut({ userAgent: agent }), false, agent);
    for (const agent of leavesOut) assert.equal(isLeftOut({ userAgent: agent }), true, agent);
    // A browser that says nothing of itself isn't left out by name: what it can do decides.
    assert.equal([isLeftOut({}), isLeftOut({ userAgent: '' }), isLeftOut({ userAgent: 'Mozilla/5.0' })], [false, false, false]);
    // Another browser on a new enough iPhone passes this, and is held to a camera's terms on each call like any other.
    assert.equal(isLeftOut({ userAgent: chromeOnAnIPhone('17.5') }), false);
});

test('a browser that is left out cannot be a camera, whatever it can do', () => {
    const able = (agent) => ({
        agent: { userAgent: agent }, secure: true, framed: false,
        mediaDevices: { getUserMedia: async () => null },
        rtc: { RTCPeerConnection: function RTCPeerConnection() {}, RTCRtpSender: {}, MediaStream: function MediaStream() {} },
    });
    assert.equal(canBeACamera(/** @type {any} */ (able(chromeOnAndroid(158)))), true);
    assert.equal(canBeACamera(/** @type {any} */ (able(safariOnAnIPhone('17.5')))), true);
    for (const agent of [chromeOnAndroid(119), safariOnAnIPhone('16.3'), 'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0']) assert.equal(canBeACamera(/** @type {any} */ (able(agent))), false, agent);
    // And one that is taken still needs the page somewhere a browser gives a camera, and not inside a frame.
    assert.equal(canBeACamera(/** @type {any} */ ({ ...able(chromeOnAndroid(158)), secure: false })), false);
    assert.equal(canBeACamera(/** @type {any} */ ({ ...able(chromeOnAndroid(158)), framed: true })), false);
    assert.equal(canBeACamera(/** @type {any} */ ({ ...able(chromeOnAndroid(158)), mediaDevices: undefined })), false);
});
