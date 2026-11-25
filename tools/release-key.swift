// The camera page's release key, on one Mac (docs/API.md, The camera page;
// docs/WEB-CAMERA.md, decision 12). A P-256 key made in the Mac's Secure
// Enclave: it signs a release's list of files, and its private half never
// leaves the Enclave, so nobody can read it out, copy it to a server or a
// build machine, or take it away with a backup.
//
//   release-key make   [--key <file>] [--no-presence]
//   release-key public [--key <file>]
//   release-key sign   [--key <file>] [--reason <text>]    the list's text on standard input
//
// What is kept is the Secure Enclave's own wrapped handle for the key, in
// one file (by default ~/Library/Application Support/PetCamPro/
// camera-page-release.key), written once and never over another. The
// handle opens only in this Mac's Secure Enclave: on another Mac, or on this
// one after it's erased, it opens nothing. So a lost Mac is a lost key, and
// the apps carry a second key for that (release keys are a list).
//
// Using the key asks for Touch ID or the Mac's password each time (user
// presence), unless it was made with --no-presence, which only a test does.
// `make` signs once to check the new key before it keeps it, so it asks too.
//
// It prints JSON on standard output: `make` and `public` the public half
// (X9.63 uncompressed, base64url: what the apps' release keys hold), `sign`
// the signature entry a release document carries, {"key", "sig"}, the
// signature ECDSA P-256 with SHA-256 over "petcam.release.v1|" and the list's
// text exactly as it came, written r then s, 64 bytes. Errors go to
// standard error, with a non-zero exit: 2 for how it was asked, 3 for a key
// that's already there, 4 for a signature the person said no to, 1 for
// anything else. tools/release-key.mjs runs it.

import CryptoKit
import Foundation
import LocalAuthentication
import Security

let signedPrefix = "petcam.release.v1|"
let checkMessage = Data("petcam.release-key.check.v1".utf8)

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

func base64url(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

func printJSON(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) else { fail("Couldn't write the answer.") }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

var arguments = Array(CommandLine.arguments.dropFirst())
let usage = "Usage: release-key make|public|sign [--key <file>] [--no-presence] [--reason <text>]"
guard let command = arguments.first else { fail(usage, code: 2) }
arguments.removeFirst()

func option(_ name: String) -> String? {
    guard let at = arguments.firstIndex(of: name) else { return nil }
    guard at + 1 < arguments.count, !arguments[at + 1].hasPrefix("--") else { fail("\(name) needs a value. \(usage)", code: 2) }
    return arguments[at + 1]
}
let known: Set<String> = ["--key", "--no-presence", "--reason"]
for argument in arguments where argument.hasPrefix("--") && !known.contains(argument) { fail("Not an option: \(argument). \(usage)", code: 2) }

let defaultKey = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/PetCamPro/camera-page-release.key")
let keyURL = option("--key").map { URL(fileURLWithPath: $0) } ?? defaultKey

guard SecureEnclave.isAvailable else {
    fail("This Mac has no Secure Enclave, so it can't hold the release key as decision 12 asks: make it on a Mac with Apple silicon or a T2 chip.")
}

/// The key the handle at `keyURL` stands for, with `reason` shown if using it asks for Touch ID or the password.
func load(reason: String) -> SecureEnclave.P256.Signing.PrivateKey {
    guard let handle = FileManager.default.contents(atPath: keyURL.path) else {
        fail("No release key at \(keyURL.path). Make one with: release-key make")
    }
    let context = LAContext()
    context.localizedReason = reason
    do {
        return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: handle, authenticationContext: context)
    } catch {
        fail("The key at \(keyURL.path) doesn't open in this Mac's Secure Enclave: it was made on another Mac, or this one has been erased since. Nothing was signed. (\(error))")
    }
}

/// A signature, or the reason there's none: said no to, or the Enclave refused.
func signature(_ key: SecureEnclave.P256.Signing.PrivateKey, over message: Data) -> P256.Signing.ECDSASignature {
    do {
        return try key.signature(for: message)
    } catch let error as LAError where error.code == .userCancel || error.code == .appCancel || error.code == .systemCancel {
        fail("Signing was cancelled: nothing was signed.", code: 4)
    } catch {
        let text = "\(error)"
        if text.contains("-128") || text.localizedCaseInsensitiveContains("cancel") { fail("Signing was cancelled: nothing was signed.", code: 4) }
        fail("The Secure Enclave didn't sign: \(text). Nothing was signed.")
    }
}

switch command {
case "make":
    if FileManager.default.fileExists(atPath: keyURL.path) {
        let existing = (try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: FileManager.default.contents(atPath: keyURL.path) ?? Data())).map { base64url($0.publicKey.x963Representation) }
        fail("A release key is already at \(keyURL.path)\(existing.map { ", its public half \($0)" } ?? ""). A release key is never replaced: nothing was made.", code: 3)
    }
    var flags: SecAccessControlCreateFlags = [.privateKeyUsage]
    let presence = !arguments.contains("--no-presence")
    if presence { flags.insert(.userPresence) }
    var problem: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, flags, &problem) else {
        fail("The Mac wouldn't set the key's access: \(problem.map { "\($0.takeRetainedValue())" } ?? "no reason given").")
    }
    let context = LAContext()
    context.localizedReason = "check the camera page's new release key"
    let key: SecureEnclave.P256.Signing.PrivateKey
    do {
        key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access, authenticationContext: context)
    } catch {
        fail("The Secure Enclave didn't make a key: \(error).")
    }
    // It works before it's kept: one signature, checked with its public half.
    guard key.publicKey.isValidSignature(signature(key, over: checkMessage), for: checkMessage) else { fail("The new key's signature didn't check out: nothing was kept.") }
    let folder = keyURL.deletingLastPathComponent()
    do {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    } catch {
        fail("Couldn't make \(folder.path): \(error). Nothing was kept.")
    }
    // Written once, and never over another: O_EXCL refuses a file that's already there.
    let handle = key.dataRepresentation
    let descriptor = open(keyURL.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
    guard descriptor >= 0 else { fail("Couldn't keep the key at \(keyURL.path) (\(String(cString: strerror(errno)))): nothing was kept.") }
    let written = handle.withUnsafeBytes { write(descriptor, $0.baseAddress, handle.count) }
    let closed = close(descriptor)
    guard written == handle.count, closed == 0 else {
        unlink(keyURL.path)
        fail("Couldn't write the key at \(keyURL.path): nothing was kept.")
    }
    printJSON(["public_key": base64url(key.publicKey.x963Representation), "path": keyURL.path, "presence": presence])

case "public":
    let key = load(reason: "read the camera page's release key")
    printJSON(["public_key": base64url(key.publicKey.x963Representation), "path": keyURL.path])

case "sign":
    let list = FileHandle.standardInput.readDataToEndOfFile()
    guard !list.isEmpty else { fail("Nothing to sign: the list's text comes on standard input.", code: 2) }
    guard String(data: list, encoding: .utf8) != nil else { fail("The list isn't UTF-8 text: nothing was signed.", code: 2) }
    let key = load(reason: option("--reason") ?? "sign a release of the camera page")
    let message = Data(signedPrefix.utf8) + list
    let made = signature(key, over: message)
    guard key.publicKey.isValidSignature(made, for: message) else { fail("The signature didn't check out with the key's own public half: nothing was signed.") }
    printJSON(["key": base64url(key.publicKey.x963Representation), "sig": base64url(made.rawRepresentation)])

default:
    fail(usage, code: 2)
}
