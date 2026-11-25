// What a camera reads of a connection's own report (`getStats`): how the
// call is encrypted and with whose certificate, the path it took, and how
// the encoder and the link are doing. Browsers name most of it alike; what
// one leaves out reads as null.

/** @param {unknown} value @returns {number | null} */
const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
/** @param {unknown} value @returns {string | null} */
const text = (value) => (typeof value === 'string' && value !== '' ? value : null);

/**
 * @typedef {object} Reading
 * @property {{ dtlsState: string | null, srtpCipher: string | null, tlsVersion: string | null, dtlsCipher: string | null, remoteFingerprint: string | null } | null} transport
 * @property {{ localType: string | null, remoteType: string | null, remotePort: number | null, relayed: boolean, availableOutgoingBitrate: number | null, roundTripTime: number | null } | null} path the pair the transport says it's using, which it is before the report calls it nominated
 * @property {{ active: boolean | null, codec: string | null, targetBitrate: number | null, framesEncoded: number | null, keyFramesEncoded: number | null, totalEncodeTime: number | null, packetsSent: number | null, bytesSent: number | null, totalPacketSendDelay: number | null, frameWidth: number | null, frameHeight: number | null, framesPerSecond: number | null, limitation: string | null, encoder: string | null } | null} video what's being sent of the picture
 * @property {{ active: boolean | null, codec: string | null, packetsSent: number | null, bytesSent: number | null } | null} audio what's being sent of the sound
 * @property {number | null} fractionLost of the picture's packets, as the far end reports
 * @property {number | null} microphoneSeconds seconds of sound the connection has had from the microphone
 */

/** @param {{ forEach: (visit: (stat: any) => void) => void }} report @returns {Reading} */
export function readingOf(report) {
    const byId = new Map();
    const byType = new Map();
    report.forEach((stat) => {
        byId.set(stat.id, stat);
        const list = byType.get(stat.type) ?? [];
        list.push(stat);
        byType.set(stat.type, list);
    });
    const first = (type, kind) => (byType.get(type) ?? []).find((stat) => kind === undefined || stat.kind === kind || stat.mediaType === kind) ?? null;
    const codecOf = (stat) => text(byId.get(stat?.codecId)?.mimeType);

    const transport = first('transport');
    const certificate = byId.get(transport?.remoteCertificateId);
    const pair = byId.get(transport?.selectedCandidatePairId) ?? (byType.get('candidate-pair') ?? []).find((p) => p.nominated === true && p.state === 'succeeded') ?? null;
    const localType = text(byId.get(pair?.localCandidateId)?.candidateType);
    const remoteType = text(byId.get(pair?.remoteCandidateId)?.candidateType);
    const video = first('outbound-rtp', 'video');
    const audio = first('outbound-rtp', 'audio');
    const far = first('remote-inbound-rtp', 'video');
    const microphone = first('media-source', 'audio');

    return {
        transport: transport && {
            dtlsState: text(transport.dtlsState),
            srtpCipher: text(transport.srtpCipher),
            tlsVersion: text(transport.tlsVersion),
            dtlsCipher: text(transport.dtlsCipher),
            remoteFingerprint: certificate && text(certificate.fingerprintAlgorithm) && text(certificate.fingerprint) ? `${certificate.fingerprintAlgorithm.toLowerCase()} ${certificate.fingerprint.toUpperCase()}` : null,
        },
        path: pair && {
            localType,
            remoteType,
            // Of a candidate the browser found by itself it keeps the address back and says the port: what a session made without the relay is judged by (relay.js).
            remotePort: number(byId.get(pair?.remoteCandidateId)?.port),
            // Either end's candidate a relay's: the call runs through TURN.
            relayed: localType === 'relay' || remoteType === 'relay',
            availableOutgoingBitrate: number(pair.availableOutgoingBitrate),
            roundTripTime: number(pair.currentRoundTripTime),
        },
        video: video && {
            active: typeof video.active === 'boolean' ? video.active : null,
            codec: codecOf(video),
            targetBitrate: number(video.targetBitrate),
            framesEncoded: number(video.framesEncoded),
            keyFramesEncoded: number(video.keyFramesEncoded),
            totalEncodeTime: number(video.totalEncodeTime),
            packetsSent: number(video.packetsSent),
            bytesSent: number(video.bytesSent),
            totalPacketSendDelay: number(video.totalPacketSendDelay),
            frameWidth: number(video.frameWidth),
            frameHeight: number(video.frameHeight),
            framesPerSecond: number(video.framesPerSecond),
            limitation: text(video.qualityLimitationReason),
            encoder: text(video.encoderImplementation),
        },
        audio: audio && {
            active: typeof audio.active === 'boolean' ? audio.active : null,
            codec: codecOf(audio),
            packetsSent: number(audio.packetsSent),
            bytesSent: number(audio.bytesSent),
        },
        fractionLost: number(far?.fractionLost),
        microphoneSeconds: number(microphone?.totalSamplesDuration),
    };
}

/** How a connection's handshake version reads, for a person: "DTLS 1.3".
 * @param {string | null} tlsVersion as the report writes it, in hex */
export const handshakeName = (tlsVersion) => (tlsVersion === 'FEFC' ? 'DTLS 1.3' : tlsVersion === 'FEFD' ? 'DTLS 1.2' : 'DTLS');
