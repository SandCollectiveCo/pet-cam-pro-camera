// Every test that runs the same in Node and in a browser's page. The
// runners (run-node.mjs, and dev/tests.js for a page) import this and
// nothing else.

import './crypto.test.js';
import './hpke.test.js';
import './invite.test.js';
import './wire.test.js';
import './temporary-camera.test.js';
import './names.test.js';
import './browsers.test.js';
import './capture.test.js';
import './rtc.test.js';
import './relay.test.js';
import './signals.test.js';
import './door.test.js';
