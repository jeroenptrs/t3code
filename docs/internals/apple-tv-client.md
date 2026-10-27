# Apple TV client

An assessment of what it takes to run T3 Code on Apple TV, with dictation as a
primary input, and to ship a private build that talks to the production T3
Connect deployment. Written 2026-10-27 against upstream `main` at `07242abff3`.

## Summary

Build the TV client as a new Expo project, `apps/tv`, on `react-native-tvos`.
Do not retarget `apps/mobile`. Reuse `packages/client-runtime`, `contracts`,
and `shared` unchanged, and lift the small mobile connection glue. Sign in on
the TV with the Clerk native SDK's email code flow, because the production
relay only accepts Clerk session JWTs for client token exchange. The TV cannot
record audio, so first-class dictation means the phone is the microphone and
the environment carries the draft to the TV.

A private build that uses the production T3 Connect needs only `cp .env.example .env`
plus two small `app.config.ts` overrides for your Apple team, bundle identifier,
and EAS project. The Clerk key, relay URL, and CLI OAuth client id in that file
are public identifiers and are the same ones in the official builds.

## What exists today

### Toolchain

| Item                           | State                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Expo SDK                       | 58.0.14, React Native 0.88.0 (`apps/mobile/package.json`)                                                 |
| `react-native-tvos`            | `0.88.0-0` is the `latest` and `0.88-stable` tag. Fabric and Hermes are supported.                        |
| `@react-native-tvos/config-tv` | 0.1.7. Retargets the Podfile and Xcode project to tvOS when `EXPO_TV=1`.                                  |
| Local Xcode                    | 27.0 with the tvOS 27.0 device and simulator SDKs installed.                                              |
| EAS                            | Logged in as `made-for-yall`. tvOS needs a hand-made provisioning profile; EAS creates only iOS profiles. |

Expo's TV guide lists these packages as supported on TV, and the app already
uses them: Application, Audio, Asset, BlurView, BuildProperties, Constants,
Crypto, DevClient, Device, Expo UI, FileSystem, Font, GlassEffect, Image,
ImageManipulator, KeepAwake, Network, Reanimated, SafeAreaContext, SecureStore,
SplashScreen, SQLite, Svg, Updates, Video.

### Native dependency audit

Podspecs in `apps/mobile/node_modules` that declare tvOS: `@expo/ui`,
`expo-asset`, `expo-blur`, `expo-constants`, `expo-crypto`, `expo-dev-client`,
`expo-file-system`, `expo-font`, `expo-glass-effect`, `expo-image`,
`expo-linking`, `expo-network`, `expo-paste-input`, `expo-quick-actions`,
`expo-secure-store`, `expo-splash-screen`, `expo-sqlite`, `expo-symbols`,
`expo-updates`, `react-native-gesture-handler`, `react-native-nitro-modules`,
`react-native-reanimated`, `react-native-safe-area-context`,
`react-native-screens` (the T3 fork keeps upstream's `:tvos => 15.1`),
`react-native-svg`, `react-native-worklets`.

iOS only: `@clerk/expo` (`:ios => '17.0'`), `@react-native-menu/menu`,
`expo-camera`, `expo-clipboard`, `expo-haptics`, `expo-image-picker`,
`expo-notifications`, `expo-sharing`, `expo-web-browser`, `expo-widgets`,
`react-native-keyboard-controller`, `react-native-webview`.

Unknown, because the package has no podspec at the path checked or ships
generated native code: `@react-native-ai/apple`, `expo-audio`, `expo-video`,
`react-native-enriched-markdown` (T3 tarball with iOS codegen output),
`react-native-pdf-jsi`, `react-native-blob-util`.

Every custom module under `apps/mobile/modules/` declares iOS or Android only.
`t3-composer-editor` is built on `UITextView`, `UIPasteboard`, and `UIKeyCommand`.
`t3-native-controls` uses `QLPreviewController`, `AVPlayerViewController`,
`UISheetPresentationController`, and `UIActivityViewController`. Those classes
do not exist on tvOS. `t3-highlights` and `t3-review-diff` are C++ and Swift
with no UIKit use found and could be given a tvOS platform line.

### How coupled the mobile app is to iOS and Android

| Measure                                                 | Count |
| ------------------------------------------------------- | ----- |
| Non-test source files in `apps/mobile/src`              | 980   |
| Files that branch on `Platform.OS` or `Platform.select` | 146   |
| Platform-split files (`*.ios.*`, `*.android.*`)         | 72    |
| Files importing `@expo/ui`                              | 32    |
| Files importing `uniwind`                               | 24    |
| Files importing `@react-native-menu/menu`               | 20    |
| Files importing `react-native-screens` directly         | 20    |
| Files importing `expo-haptics`                          | 19    |
| Files importing `react-native-keyboard-controller`      | 15    |
| Files importing `@clerk/expo`                           | 8     |
| Files importing `react-native-webview`                  | 7     |
| Uses of `Platform.isTV`                                 | 0     |

The `features/threads` directory alone is 154 files and renders through the
native composer editor and `react-native-enriched-markdown`. The Expo TV guide
also states that a Podfile may target only iOS or tvOS, and recommends that
every project in a monorepo use the TV fork when one does. pnpm's isolated
`node_modules` lets `apps/tv` alias `react-native` to `react-native-tvos`
without touching `apps/mobile`, but that needs verifying with Metro before
committing to it.

Conclusion: a TV target inside `apps/mobile` would mean a tvOS branch in
most of those 146 files and stubs for nine native modules. A separate
`apps/tv` that reuses the platform-free packages is less work and keeps
`apps/mobile` untouched.

### What is reusable without change

`packages/client-runtime` has no React Native, Expo, or Clerk imports. The
connection core (`connection/`, `authorization/`), the thread state
(`state/`), and the voice controller (`voice-input/`) are injected through
`ClientCapabilities`. The mobile glue that a TV client would copy is small:

- `apps/mobile/src/connection/platform.ts` (Effect layers, connectivity, wakeups)
- `apps/mobile/src/features/cloud/dpop.ts` (P-256 DPoP signing with `@noble/curves`, key in `expo-secure-store`)
- `apps/mobile/src/features/cloud/managedRelayLayer.ts` and `managedRelayTokenStore.ts`
- `apps/mobile/src/connection/catalog-store.ts` and `persistence/mobile-secure-storage.ts`
- `apps/mobile/src/features/cloud/CloudAuthProvider.tsx` (Clerk provider and token cache)

All of their native dependencies (`expo-secure-store`, `expo-crypto`,
`expo-network`, `expo-sqlite`) declare tvOS.

The server identifies clients through `AuthClientMetadata`
(`packages/contracts/src/auth.ts`). `deviceType` has no `tv` value and
`ClientSurface` is `web | desktop | mobile | cli`. A TV would currently
register as `unknown` on surface `mobile`. Adding `tv` to both unions and to
`apps/mobile/src/lib/authClientMetadata.ts` (which already maps `expo-device`
types, and `DeviceType.TV` exists) is a contracts change the TV client needs
first, so that the sessions list and the relay can tell it apart.

## Sign-in on the TV

Three facts decide this.

1. `@clerk/expo` renders sign-in only through the native `AuthView`
   (`apps/mobile/src/features/settings/SettingsAuthRouteScreen.tsx`). Its
   podspec is iOS-only, but the underlying `clerk-ios` package declares
   tvOS 17 for both `ClerkKit` and `ClerkKitUI`. Whether `ClerkKitUI` compiles
   and lays out on tvOS is unverified.
2. tvOS has no `ASWebAuthenticationSession` and no web view. Google and any
   other browser-based OAuth cannot run on the TV. Sign in with Apple and
   passkeys do run on tvOS through `ASAuthorizationController`, with the
   iPhone as the passkey authenticator.
3. The relay's client token exchange (`exchangeDpopAccessToken` in
   `infra/relay/src/http/Api.ts`) verifies the bearer with
   `verifyClerkBearerToken` and the `t3-relay` audience only. The CLI's
   OAuth tokens are accepted by `verifyRelayClientBearerToken`, which other
   routes use, but not by this one.

So the server's existing device authorization grant
(`apps/server/src/cloud/CliTokenManager.ts`, `deviceAuthorizationLogin`)
would be the ideal TV sign-in, with a code on screen and approval on the
phone, but it produces a CLI OAuth token that the production relay rejects at
the exchange step. Using it needs a one-line relay change to call
`verifyRelayClientBearerToken` there, and that change has to land upstream
and deploy before a private build can benefit.

Recommended order:

1. Ship with the Clerk native SDK on tvOS using the email code strategy,
   which needs only the publishable key. Wrap `ClerkKit` in a small Expo module
   for `apps/tv` instead of depending on `@clerk/expo`'s iOS-only podspec.
   Confirm first that `ClerkKit` builds for the `appletvos` SDK.
2. Propose the relay change upstream so the TV can switch to the device grant
   and drop the Clerk UI entirely.

Pairing without T3 Connect works today on any platform. The pairing URL
parser in `apps/mobile/src/features/connection/pairing.ts` is pure
TypeScript, and the TV can take a typed host and code. The QR scanner
(`expo-camera`) has no tvOS equivalent and is dropped.

## Dictation

### The TV has no microphone a third-party app can use

Apple's developer forum answer on tvOS states that the SDK has no microphone
access, and the `record` and `playAndRecord` audio session categories fail at
runtime even though they compile. Nothing newer contradicts that.
`SpeechAnalyzer` is listed for tvOS 26, but without audio input it can only
transcribe files. The current iOS binding
(`apps/mobile/src/native/voiceTranscription.ios.ts`) records with
`expo-audio` and transcribes through `@react-native-ai/apple`, which needs
iOS 26 and is unavailable at runtime elsewhere.

One input path does exist for free: a React Native `TextInput` on tvOS opens
the system keyboard, and that keyboard supports Siri Remote dictation and the
Continuity keyboard from a nearby iPhone. It is modal and full screen, which
is why it is a fallback rather than the design.

### Design: the phone is the microphone, the environment carries the draft

The voice controller in `packages/client-runtime/src/voice-input/controller.ts`
already separates "where the audio comes from" from "which draft the text
lands in", and it protects the draft with an `ownerKey` and a `revision`.
What is missing is a draft that two clients can see. Today drafts are local
files on mobile (`apps/mobile/src/state/use-composer-drafts.ts`) and
`localStorage` on web (`apps/web/src/composerDraftStore.ts`); contracts have
no draft entity and `docs/internals/connection-runtime.md` calls drafts
platform-owned.

Three phases, each usable on its own.

**Phase 1: handoff, no server change.** The TV composer shows a "Dictate from
your iPhone" action. Selecting it renders a QR code and sends a push through
the relay's existing `/v1/mobile/devices` registration with a deep link,
`t3code://thread/<id>?dictate=1`. The phone opens the thread with the existing
`ComposerDictationStartAction` already recording. The user sends from the
phone, and the TV sees the message through the normal thread stream. Work:
a TV screen, one deep-link parameter in `apps/mobile/src/Stack.tsx`, and one
auto-start in `ThreadComposer.tsx`.

**Phase 2: mirrored draft.** Add a per-thread, per-owner draft to the
environment: a `ComposerDraft { threadId, ownerKey, text, selection, revision,
updatedAt, clientSessionId }` in `packages/contracts`, two commands
(`draft.replace`, `draft.clear`) and one event (`draft.changed`) on the
orchestration stream, stored in SQLite next to the queue. The phone's voice
controller commits the transcript to the shared draft instead of its local
one, reusing `resolveTranscriptCommit` and its stale check. The TV subscribes
and shows the transcript as it lands. The TV remote then confirms send, and
the TV submits the message. Revision conflicts use the existing rule: a draft
edited elsewhere since recording started drops the transcript.

**Phase 3: environment-backed transcription.** `docs/internals/voice-input.md`
names this as not implemented. The phone uploads the recording to the
environment, which runs a transcriber (a provider, or a local model on the
host) and writes the shared draft. This frees dictation from iOS 26 hardware
and makes it available to Android, desktop, and web with the same draft
mirroring. It is independent of the TV and is the larger piece of work.

The TV's own fallback stays the system keyboard with Siri Remote dictation,
with the shared draft so that text typed on the TV also shows on the phone.

## Build and distribution

### Project layout

```
apps/tv/
  package.json        react-native: npm:react-native-tvos@0.88.0-0
  app.config.ts       plugins: @react-native-tvos/config-tv, expo-secure-store, expo-sqlite, ...
  src/                connection glue copied from apps/mobile, TV screens
```

Steps to a first run on the simulator:

1. Create `apps/tv` with the Expo `with-tv` template shape and the same
   `loadRepoEnv` configuration loader as mobile.
2. Depend on `@t3tools/client-runtime`, `contracts`, `shared`, `effect`,
   `@effect/atom-react`, and the tvOS-declared Expo packages listed above.
3. Run `EXPO_TV=1 expo prebuild --clean` and `expo run:ios` against the
   tvOS 27 simulator.
4. Add `tv` to `AuthClientMetadataDeviceType` and `ClientSurface`.
5. Port the thread list and thread detail with pure React Native views.
   Markdown needs a JavaScript renderer on the TV; the mobile one is native.
   Focus handling uses `TVFocusGuideView` and `Pressable` `onFocus`.
6. Sign-in as described above, then the Phase 1 dictation handoff.

Things that do not carry over: widgets, share extension, notifications in
the app (the TV can still be a push target for the handoff), terminal view,
review diff, Quick Look file previews, camera pairing, haptics.

### EAS

tvOS shares the bundle identifier and distribution certificate with iOS but
needs its own provisioning profile, created by hand in the developer portal.
Expo's guide suggests `development_tv` and `preview_tv` profiles that extend
the phone profiles and set `EXPO_TV=1`. On Apple TV the dev client works with
a local or tunneled packager, but EAS login and build listing inside the dev
client do not.

## A private build against production T3 Connect

### What already works

`cp .env.example .env` sets `T3CODE_CLERK_PUBLISHABLE_KEY`,
`T3CODE_CLERK_JWT_TEMPLATE`, `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`, and
`T3CODE_RELAY_URL` to the production values. The file says these are the
same public identifiers baked into official release builds. The mobile config
loader (`scripts/lib/public-config.ts`) maps them to the `EXPO_PUBLIC_*`
names the app reads. No secret is involved.

### What needs a fork change

`apps/mobile/app.config.ts` hard-codes `appleTeamId: "ARK85ZXQ4Z"`,
`owner: "pingdotgg"`, the EAS `projectId`, and `com.t3tools.t3code*` bundle
identifiers. The only override is `T3CODE_IOS_PERSONAL_TEAM=1`, which also
strips widgets, the share extension, push, and Sign in with Apple. Your
Keychain holds Apple Development and Apple Distribution identities for team
`7RJS2LBMGB`, so you are not on a Personal Team and that stripped path is the
wrong one.

Your repository-root `.env.local` already sets `T3CODE_EXPO_OWNER`,
`T3CODE_EXPO_PROJECT_ID`, `T3CODE_IOS_APPLE_TEAM_ID`, and
`T3CODE_IOS_BUNDLE_ID`. Nothing on `main` or `jeroen/dev` reads them. They
survive from an earlier fork. The change is to make `app.config.ts` honor
them for `appleTeamId`, `owner`, `extra.eas.projectId`, the bundle identifier,
and the derived widget, sharing, and keychain group identifiers.

### What will and will not work with a foreign bundle identifier

Works: Clerk email code sign-in through `AuthView`, because it needs only the
publishable key. Relay environment discovery and connect, because the relay
checks the Clerk session, not the app identity. Pairing without T3 Connect.

Does not work until T3 registers your app in their Clerk instance:
passkeys (the `apple-app-site-association` on `clerk.t3.codes` lists only
their team), Sign in with Apple, and Google sign-in (no iOS client id in the
build). Push notifications through the relay also assume T3's APNs
credentials for their bundle identifier, so a private build should expect
silent push failures. The Android allowlist note in
`docs/operations/connect-setup.md` describes the same constraint for Android
packages.

For the TV, the device grant path would remove the Clerk UI and these
identity constraints entirely, which is another reason to propose the relay
change upstream.

## Status as of 2026-10-27

The open questions from the first draft are answered, and `apps/tv` exists on
this branch.

- `react-native-tvos@0.88.0-0` coexists with the mobile app under pnpm. Metro
  needed a resolver pin in `apps/tv/metro.config.js`, because Expo's workspace
  autolinking walked up to the upstream `react-native` copy.
- ClerkKit 1.3.3 compiles for tvOS, but every ClerkKitUI view is excluded
  there. It did not matter: `@clerk/expo` 4.14 runs headless on `clerk-js`
  with no native pod, so the TV signs in with a plain React Native email code
  screen. Production Clerk answered from the simulator. Sign-up, OAuth, Apple,
  and passkeys are not offered on the TV. Upgrading clerk-ios past 1.6.1
  breaks ClerkKitUI for tvOS; the TV does not depend on it.
- The markdown renderer is TypeScript over `remark-parse`, with each block a
  focus stop so the remote scrolls long replies.
- Pairing by host and code, reconnect on launch, environment and thread
  lists, a thread view with live streaming, and sending a reply all work on
  the tvOS 27 simulator against a local server. The reply box is a native text
  input, so the tvOS keyboard with Siri dictation and the iPhone Continuity
  keyboard are the dictation path today.
- The client sends device type `unknown` on the wire, because released servers
  reject `tv`. The contracts and server on this branch accept `tv`; switch the
  client once that server has shipped.
- Not verified: remote-button navigation, a real sign-in and the relay
  environment list, and a device build. This Xcode install has no
  Simulator.app, so those wait for hardware. `apps/tv/README.md` has the
  device steps.
- Still to do from the dictation design: the phone handoff and the mirrored
  draft. The upstream relay change for the device grant is not proposed yet.

## Sources

- Expo, [Build Expo apps for TV](https://docs.expo.dev/guides/building-for-tv/)
- react-native-tvos, [README](https://github.com/react-native-tvos/react-native-tvos/)
- Clerk, [clerk-ios Package.swift](https://github.com/clerk/clerk-ios/blob/main/Package.swift)
- Clerk, [OAuth device authorization grant](https://clerk.com/docs/guides/configure/auth-strategies/oauth/device-authorization-grant)
- Apple Developer Forums, [Audio input on the Apple TV simulator](https://developer.apple.com/forums/thread/17391)
- Apple Support, [Use the iOS or iPadOS keyboard to enter text on Apple TV](https://support.apple.com/guide/tv/atvb827791d6/)
